import { acquireLock, withDistributedLock } from '../../src/utils/distributedLock';
import { redis } from '../../src/config/redis';

// Mock Redis
jest.mock('../../src/config/redis', () => ({
  redis: {
    set: jest.fn(),
    eval: jest.fn(),
  },
}));

// Mock logger
jest.mock('../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

describe('distributedLock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('acquireLock', () => {
    it('should acquire lock when not already held', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');

      const lock = await acquireLock({ key: 'test-lock', ttl: 60 });

      expect(lock).not.toBeNull();
      expect(lock?.key).toBe('test-lock');
      expect(lock?.identifier).toBeDefined();
      expect(redis.set).toHaveBeenCalledWith('test-lock', expect.any(String), 'EX', 60, 'NX');
    });

    it('should return null when lock is already held', async () => {
      (redis.set as jest.Mock).mockResolvedValue(null);

      const lock = await acquireLock({ key: 'test-lock', ttl: 60 });

      expect(lock).toBeNull();
      expect(redis.set).toHaveBeenCalledWith('test-lock', expect.any(String), 'EX', 60, 'NX');
    });

    it('should use custom identifier when provided', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');

      const lock = await acquireLock({ key: 'test-lock', ttl: 60, identifier: 'custom-id' });

      expect(lock).not.toBeNull();
      expect(lock?.identifier).toBe('custom-id');
      expect(redis.set).toHaveBeenCalledWith('test-lock', 'custom-id', 'EX', 60, 'NX');
    });

    it('should handle Redis errors gracefully', async () => {
      (redis.set as jest.Mock).mockRejectedValue(new Error('Redis connection failed'));

      const lock = await acquireLock({ key: 'test-lock', ttl: 60 });

      expect(lock).toBeNull();
    });

    it('should release lock correctly', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');
      (redis.eval as jest.Mock).mockResolvedValue(1);

      const lock = await acquireLock({ key: 'test-lock', ttl: 60 });
      expect(lock).not.toBeNull();

      await lock!.release();

      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("get", KEYS[1])'),
        1,
        'test-lock',
        lock!.identifier
      );
    });

    it('should handle lock release when already expired', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');
      (redis.eval as jest.Mock).mockResolvedValue(0);

      const lock = await acquireLock({ key: 'test-lock', ttl: 60 });
      expect(lock).not.toBeNull();

      await lock!.release();

      expect(redis.eval).toHaveBeenCalled();
    });
  });

  describe('withDistributedLock', () => {
    it('should execute job when lock is acquired', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');
      (redis.eval as jest.Mock).mockResolvedValue(1);

      const mockJob = jest.fn().mockResolvedValue(undefined);
      const wrappedJob = withDistributedLock('test-job', 60, mockJob);

      await wrappedJob();

      expect(redis.set).toHaveBeenCalledWith('cron:lock:test-job', expect.any(String), 'EX', 60, 'NX');
      expect(mockJob).toHaveBeenCalledTimes(1);
      expect(redis.eval).toHaveBeenCalled();
    });

    it('should skip job when lock is already held', async () => {
      (redis.set as jest.Mock).mockResolvedValue(null);

      const mockJob = jest.fn().mockResolvedValue(undefined);
      const wrappedJob = withDistributedLock('test-job', 60, mockJob);

      await wrappedJob();

      expect(redis.set).toHaveBeenCalledWith('cron:lock:test-job', expect.any(String), 'EX', 60, 'NX');
      expect(mockJob).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('should release lock even if job throws error', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');
      (redis.eval as jest.Mock).mockResolvedValue(1);

      const mockJob = jest.fn().mockRejectedValue(new Error('Job failed'));
      const wrappedJob = withDistributedLock('test-job', 60, mockJob);

      await expect(wrappedJob()).rejects.toThrow('Job failed');

      expect(mockJob).toHaveBeenCalledTimes(1);
      expect(redis.eval).toHaveBeenCalled();
    });

    it('should ensure only one of two concurrent executions runs', async () => {
      let lockAcquiredCount = 0;
      (redis.set as jest.Mock).mockImplementation(() => {
        lockAcquiredCount++;
        // First call succeeds, second fails
        return Promise.resolve(lockAcquiredCount === 1 ? 'OK' : null);
      });
      (redis.eval as jest.Mock).mockResolvedValue(1);

      const executionCount = { count: 0 };
      const mockJob = jest.fn().mockImplementation(async () => {
        executionCount.count++;
        // Simulate some work
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const wrappedJob = withDistributedLock('test-job', 60, mockJob);

      // Simulate two instances trying to run the same job concurrently
      await Promise.all([wrappedJob(), wrappedJob()]);

      // Only one should have executed
      expect(mockJob).toHaveBeenCalledTimes(1);
      expect(executionCount.count).toBe(1);
      expect(redis.set).toHaveBeenCalledTimes(2);
    });
  });
});
