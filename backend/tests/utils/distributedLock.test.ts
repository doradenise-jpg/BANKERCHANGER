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

  describe('Lock TTL expiry - stale lock recovery', () => {
    it('should allow second caller to acquire lock after TTL expires', async () => {
      jest.useFakeTimers();

      try {
        // First caller acquires the lock with very short TTL
        const lockAcquireTime = Date.now();
        (redis.set as jest.Mock).mockResolvedValue('OK');
        (redis.eval as jest.Mock).mockResolvedValue(1);

        const lock1 = await acquireLock({ key: 'expiring-lock', ttl: 2, identifier: 'caller-1' });

        expect(lock1).not.toBeNull();
        expect(lock1?.identifier).toBe('caller-1');

        // Verify first caller holds the lock
        expect(redis.set).toHaveBeenCalledWith('expiring-lock', 'caller-1', 'EX', 2, 'NX');

        // Reset mock to simulate lock expiry behavior
        (redis.set as jest.Mock).mockClear();
        (redis.set as jest.Mock).mockResolvedValue('OK'); // Now succeeds for new caller

        // Advance time past the TTL (2 seconds + 1 more second = lock expired)
        jest.advanceTimersByTime(3000);

        // Second caller attempts to acquire the same lock
        const lock2 = await acquireLock({ key: 'expiring-lock', ttl: 60, identifier: 'caller-2' });

        // Second caller should successfully acquire because first lock expired
        expect(lock2).not.toBeNull();
        expect(lock2?.identifier).toBe('caller-2');
        expect(redis.set).toHaveBeenCalledWith('expiring-lock', 'caller-2', 'EX', 60, 'NX');

        // First caller tries to release their expired lock (should fail gracefully)
        (redis.eval as jest.Mock).mockResolvedValue(0); // Returns 0 because lock was already expired

        await lock1!.release();

        // Should attempt release but log that lock was already expired
        expect(redis.eval).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should handle a long-running job where lock expires mid-execution', async () => {
      jest.useFakeTimers();

      try {
        (redis.set as jest.Mock).mockResolvedValue('OK');
        (redis.eval as jest.Mock).mockResolvedValue(1);

        // First caller acquires lock with 2-second TTL
        const lock1 = await acquireLock({ key: 'quick-expiry-lock', ttl: 2, identifier: 'slow-job' });
        expect(lock1).not.toBeNull();

        // Simulate a job that takes 5 seconds
        const jobExecutionStart = Date.now();
        let jobExecutionEnd: number | undefined;

        const slowJob = async () => {
          await new Promise((resolve) => {
            // Simulate async work that spans 5 seconds
            setTimeout(() => {
              jobExecutionEnd = Date.now();
              resolve(undefined);
            }, 5000);
          });
        };

        // Start the job (in real scenario, this is the long-running cron job)
        const jobPromise = slowJob();

        // After 2.5 seconds, the lock should have expired (set TTL was 2 seconds)
        jest.advanceTimersByTime(2500);

        // Now a second caller should be able to acquire the "same" lock that's expired
        (redis.set as jest.Mock).mockClear();
        (redis.set as jest.Mock).mockResolvedValue('OK'); // New caller can acquire

        const lock2 = await acquireLock({ 
          key: 'quick-expiry-lock', 
          ttl: 60, 
          identifier: 'other-job-instance' 
        });

        expect(lock2).not.toBeNull();
        expect(lock2?.identifier).toBe('other-job-instance');

        // Complete the slow job
        jest.advanceTimersByTime(2500);
        await jobPromise;

        // First caller tries to release their lock (but it expired and was taken over)
        (redis.eval as jest.Mock).mockClear();
        (redis.eval as jest.Mock).mockResolvedValue(0); // Lock doesn't exist or belongs to someone else

        await lock1!.release();

        // Release should be attempted but log that lock expired
        expect(redis.eval).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should prevent stale lock from blocking subsequent calls permanently', async () => {
      jest.useFakeTimers();

      try {
        (redis.set as jest.Mock).mockResolvedValue('OK');
        (redis.eval as jest.Mock).mockResolvedValue(1);

        // Scenario: Instance A crashes without releasing lock
        const staleLock = await acquireLock({ 
          key: 'potentially-stale-lock', 
          ttl: 3, 
          identifier: 'crashed-instance' 
        });

        expect(staleLock).not.toBeNull();

        // Advance time to after TTL expires
        jest.advanceTimersByTime(4000);

        // Reset mock for new attempt
        (redis.set as jest.Mock).mockClear();
        (redis.set as jest.Mock).mockResolvedValue('OK');

        // Instance B should be able to acquire the same lock immediately
        const newLock = await acquireLock({ 
          key: 'potentially-stale-lock', 
          ttl: 60, 
          identifier: 'recovery-instance' 
        });

        expect(newLock).not.toBeNull();
        expect(newLock?.identifier).toBe('recovery-instance');

        // Verify we didn't have to wait or do any special cleanup
        expect(redis.set).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should handle wrapped job timeout and lock expiry correctly', async () => {
      jest.useFakeTimers();

      try {
        (redis.set as jest.Mock).mockResolvedValue('OK');
        (redis.eval as jest.Mock).mockResolvedValue(1);

        let firstJobRan = false;
        let secondJobRan = false;

        // First job with short TTL (simulates a stuck job)
        const firstJob = jest.fn().mockImplementation(async () => {
          firstJobRan = true;
          // Simulate long-running job
          await new Promise((resolve) => setTimeout(resolve, 10000));
        });

        const wrappedFirstJob = withDistributedLock('stuck-job', 3, firstJob);

        // Start first job (will take 10 seconds but TTL is only 3)
        const jobPromise1 = wrappedFirstJob();

        // After 4 seconds (1 second past TTL expiry)
        jest.advanceTimersByTime(4000);

        // Reset mock to allow second caller to acquire lock
        (redis.set as jest.Mock).mockClear();
        (redis.set as jest.Mock).mockResolvedValue('OK');

        // Second job should be able to start now even though first is still "running"
        const secondJob = jest.fn().mockResolvedValue(undefined);
        const wrappedSecondJob = withDistributedLock('stuck-job', 60, secondJob);

        await wrappedSecondJob();

        secondJobRan = true;

        // Verify both tracking that second job ran even though first was still executing
        expect(secondJobRan).toBe(true);
        expect(secondJob).toHaveBeenCalledTimes(1);

        // Cleanup: finish the first job
        jest.advanceTimersByTime(6000);
        await jobPromise1;

        expect(firstJobRan).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
