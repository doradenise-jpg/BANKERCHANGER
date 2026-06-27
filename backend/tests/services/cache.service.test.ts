// ============================================================
// BOXMEOUT — Cache Service Unit Tests
// Tests for centralized cache invalidation service
// ============================================================

import * as cache from '../../src/services/cache.service';
import { redis } from '../../src/config/redis';

// Mock the Redis client
jest.mock('../../src/config/redis', () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    scan: jest.fn(),
  },
}));

// Mock the logger
jest.mock('../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

describe('Cache Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('get', () => {
    it('should return parsed value when key exists', async () => {
      const mockData = { id: '123', name: 'Test Market' };
      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(mockData));

      const result = await cache.get<typeof mockData>('market:123');

      expect(redis.get).toHaveBeenCalledWith('market:123');
      expect(result).toEqual(mockData);
    });

    it('should return null when key does not exist', async () => {
      (redis.get as jest.Mock).mockResolvedValue(null);

      const result = await cache.get('market:nonexistent');

      expect(redis.get).toHaveBeenCalledWith('market:nonexistent');
      expect(result).toBeNull();
    });

    it('should return null and log warning when Redis fails', async () => {
      (redis.get as jest.Mock).mockRejectedValue(new Error('Redis connection failed'));

      const result = await cache.get('market:123');

      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('should store value with TTL', async () => {
      const mockData = { id: '123', name: 'Test Market' };
      (redis.set as jest.Mock).mockResolvedValue('OK');

      await cache.set('market:123', mockData, 60);

      expect(redis.set).toHaveBeenCalledWith(
        'market:123',
        JSON.stringify(mockData),
        'EX',
        60
      );
    });

    it('should handle Redis failure gracefully', async () => {
      (redis.set as jest.Mock).mockRejectedValue(new Error('Redis connection failed'));

      await expect(cache.set('market:123', { test: 'data' }, 60)).resolves.not.toThrow();
    });
  });

  describe('del', () => {
    it('should delete a single key', async () => {
      (redis.del as jest.Mock).mockResolvedValue(1);

      await cache.del('market:123');

      expect(redis.del).toHaveBeenCalledWith('market:123');
    });

    it('should handle Redis failure gracefully', async () => {
      (redis.del as jest.Mock).mockRejectedValue(new Error('Redis connection failed'));

      await expect(cache.del('market:123')).resolves.not.toThrow();
    });
  });

  describe('delPattern', () => {
    it('should delete all keys matching pattern', async () => {
      // Mock SCAN to return keys in batches
      (redis.scan as jest.Mock)
        .mockResolvedValueOnce(['10', ['market:1', 'market:2']])
        .mockResolvedValueOnce(['0', ['market:3']]);
      
      (redis.del as jest.Mock).mockResolvedValue(3);

      await cache.delPattern('market:*');

      expect(redis.scan).toHaveBeenCalledTimes(2);
      expect(redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'market:*', 'COUNT', 100);
      expect(redis.scan).toHaveBeenNthCalledWith(2, '10', 'MATCH', 'market:*', 'COUNT', 100);
      expect(redis.del).toHaveBeenCalledWith('market:1', 'market:2', 'market:3');
    });

    it('should handle empty result set', async () => {
      (redis.scan as jest.Mock).mockResolvedValue(['0', []]);

      await cache.delPattern('nonexistent:*');

      expect(redis.scan).toHaveBeenCalledTimes(1);
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('should handle Redis failure gracefully', async () => {
      (redis.scan as jest.Mock).mockRejectedValue(new Error('Redis connection failed'));

      await expect(cache.delPattern('market:*')).resolves.not.toThrow();
    });
  });

  describe('getOrSet', () => {
    it('should return cached value if exists', async () => {
      const mockData = { id: '123', name: 'Test Market' };
      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(mockData));

      const compute = jest.fn();
      const result = await cache.getOrSet('market:123', 60, compute);

      expect(redis.get).toHaveBeenCalledWith('market:123');
      expect(compute).not.toHaveBeenCalled();
      expect(result).toEqual(mockData);
    });

    it('should compute and cache value on cache miss', async () => {
      const mockData = { id: '123', name: 'Test Market' };
      (redis.get as jest.Mock).mockResolvedValue(null);
      (redis.set as jest.Mock).mockResolvedValue('OK');

      const compute = jest.fn().mockResolvedValue(mockData);
      const result = await cache.getOrSet('market:123', 60, compute);

      expect(redis.get).toHaveBeenCalledWith('market:123');
      expect(compute).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        'market:123',
        JSON.stringify(mockData),
        'EX',
        60
      );
      expect(result).toEqual(mockData);
    });

    it('should compute value without caching on Redis failure', async () => {
      const mockData = { id: '123', name: 'Test Market' };
      (redis.get as jest.Mock).mockRejectedValue(new Error('Redis connection failed'));

      const compute = jest.fn().mockResolvedValue(mockData);
      const result = await cache.getOrSet('market:123', 60, compute);

      expect(compute).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockData);
    });
  });

  describe('Cache invalidation workflow', () => {
    it('should invalidate cache after set and get returns null', async () => {
      const mockData = { id: '123', name: 'Test Market' };
      
      // Set value
      (redis.set as jest.Mock).mockResolvedValue('OK');
      await cache.set('market:123', mockData, 60);
      expect(redis.set).toHaveBeenCalled();

      // Get value (simulate cache hit)
      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify(mockData));
      let result = await cache.get<typeof mockData>('market:123');
      expect(result).toEqual(mockData);

      // Invalidate
      (redis.del as jest.Mock).mockResolvedValue(1);
      await cache.del('market:123');
      expect(redis.del).toHaveBeenCalledWith('market:123');

      // Get after invalidation (simulate cache miss)
      (redis.get as jest.Mock).mockResolvedValue(null);
      result = await cache.get<typeof mockData>('market:123');
      expect(result).toBeNull();
    });
  });

  describe('Namespaced keys', () => {
    it('should work with market namespace', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');
      await cache.set('market:abc123', { status: 'open' }, 30);
      expect(redis.set).toHaveBeenCalledWith(
        'market:abc123',
        JSON.stringify({ status: 'open' }),
        'EX',
        30
      );
    });

    it('should work with leaderboard namespace', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');
      await cache.set('leaderboard:global:top10', [{ rank: 1 }], 120);
      expect(redis.set).toHaveBeenCalledWith(
        'leaderboard:global:top10',
        JSON.stringify([{ rank: 1 }]),
        'EX',
        120
      );
    });

    it('should work with user balance namespace', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');
      await cache.set('user:user123:balance', { balance: 1000 }, 60);
      expect(redis.set).toHaveBeenCalledWith(
        'user:user123:balance',
        JSON.stringify({ balance: 1000 }),
        'EX',
        60
      );
    });

    it('should invalidate all market keys with pattern', async () => {
      (redis.scan as jest.Mock).mockResolvedValue(['0', ['market:1', 'market:2', 'market:3']]);
      (redis.del as jest.Mock).mockResolvedValue(3);

      await cache.delPattern('market:*');

      expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'market:*', 'COUNT', 100);
      expect(redis.del).toHaveBeenCalledWith('market:1', 'market:2', 'market:3');
    });

    it('should invalidate all leaderboard keys with pattern', async () => {
      (redis.scan as jest.Mock).mockResolvedValue(['0', ['leaderboard:global:top10', 'leaderboard:global:top100']]);
      (redis.del as jest.Mock).mockResolvedValue(2);

      await cache.delPattern('leaderboard:global:*');

      expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'leaderboard:global:*', 'COUNT', 100);
      expect(redis.del).toHaveBeenCalledWith('leaderboard:global:top10', 'leaderboard:global:top100');
    });
  });

  describe('Legacy aliases', () => {
    it('should support cacheGet alias', async () => {
      (redis.get as jest.Mock).mockResolvedValue(JSON.stringify({ test: 'data' }));
      const result = await cache.cacheGet('test:key');
      expect(result).toEqual({ test: 'data' });
    });

    it('should support cacheSet alias', async () => {
      (redis.set as jest.Mock).mockResolvedValue('OK');
      await cache.cacheSet('test:key', { test: 'data' }, 60);
      expect(redis.set).toHaveBeenCalled();
    });

    it('should support cacheDelete alias', async () => {
      (redis.del as jest.Mock).mockResolvedValue(1);
      await cache.cacheDelete('test:key');
      expect(redis.del).toHaveBeenCalledWith('test:key');
    });

    it('should support cacheDeletePattern alias', async () => {
      (redis.scan as jest.Mock).mockResolvedValue(['0', ['test:1', 'test:2']]);
      (redis.del as jest.Mock).mockResolvedValue(2);
      await cache.cacheDeletePattern('test:*');
      expect(redis.scan).toHaveBeenCalled();
    });
  });

  describe('Redis connection failure handling', () => {
    it('should gracefully degrade when Redis is unavailable', async () => {
      const testError = new Error('ECONNREFUSED: Connection refused');
      (redis.get as jest.Mock).mockRejectedValue(testError);
      (redis.set as jest.Mock).mockRejectedValue(testError);
      (redis.del as jest.Mock).mockRejectedValue(testError);

      // Should not throw - all operations should handle gracefully
      const getResult = await cache.get('test:key');
      expect(getResult).toBeNull();

      await expect(cache.set('test:key', { data: 'test' }, 60)).resolves.not.toThrow();
      await expect(cache.del('test:key')).resolves.not.toThrow();
    });

    it('should allow compute function to proceed when Redis is unavailable', async () => {
      const mockData = { id: '123', computed: true };
      (redis.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      const compute = jest.fn().mockResolvedValue(mockData);
      const result = await cache.getOrSet('test:key', 60, compute);

      expect(compute).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockData);
    });
  });
});
