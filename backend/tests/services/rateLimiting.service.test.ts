// ============================================================
// Tests for Rate Limiting Service
// ============================================================

import { redis } from '../../src/config/redis';
import {
  checkLimit,
  checkLimitByTier,
  resetLimit,
  getCurrentCount,
  RATE_LIMITS,
} from '../../src/services/rateLimiting.service';

describe('RateLimitingService', () => {
  const TEST_KEY = `test:ratelimit:${Date.now()}`;

  beforeAll(async () => {
    // Connect to Redis if not already connected
    if (redis.status === 'offline') {
      await redis.connect();
    }
  });

  afterEach(async () => {
    // Clean up test keys
    const pattern = `ratelimit:${TEST_KEY}*`;
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (batch.length > 0) {
        await redis.del(...batch);
      }
    } while (cursor !== '0');
  });

  afterAll(async () => {
    await redis.quit();
  });

  describe('checkLimit - basic functionality', () => {
    it('should allow first request', async () => {
      const result = await checkLimit(TEST_KEY, 5, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // 5 - 1
      expect(result.reset_at).toBeGreaterThan(0);
    });

    it('should track remaining quota correctly', async () => {
      const limit = 5;
      for (let i = 0; i < limit; i++) {
        const result = await checkLimit(TEST_KEY, limit, 60);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(limit - i - 1);
      }

      // 6th request should be rejected
      const result = await checkLimit(TEST_KEY, limit, 60);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should reject when limit is exceeded', async () => {
      const limit = 3;
      
      // Fill the limit
      for (let i = 0; i < limit; i++) {
        await checkLimit(TEST_KEY, limit, 60);
      }

      // Next request should be rejected
      const result = await checkLimit(TEST_KEY, limit, 60);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should return valid reset_at timestamp', async () => {
      const result = await checkLimit(TEST_KEY, 5, 60);
      const now = Math.floor(Date.now() / 1000);
      
      // reset_at should be in the future (within 61 seconds)
      expect(result.reset_at).toBeGreaterThanOrEqual(now);
      expect(result.reset_at).toBeLessThanOrEqual(now + 61);
    });
  });

  describe('checkLimit - sliding window behavior', () => {
    it('should correctly track sliding window', async () => {
      const limit = 2;
      const window = 2; // 2 seconds for fast testing

      // First request
      let result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);

      // Second request
      result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);

      // Third request (should be rejected - at limit)
      result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 2100));

      // After window expires, should allow again
      result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it('should handle partial window expiration', async () => {
      const limit = 3;
      const window = 1; // 1 second

      // Add 2 requests
      await checkLimit(TEST_KEY, limit, window);
      await checkLimit(TEST_KEY, limit, window);

      // Wait for entries to age but not expire
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should still count 2 requests
      let count = await getCurrentCount(TEST_KEY, window);
      expect(count).toBeGreaterThanOrEqual(1); // At least 1, may be 2

      // Wait for window to fully expire
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Window should be cleared
      count = await getCurrentCount(TEST_KEY, window);
      expect(count).toBe(0);

      // Should allow new requests
      const result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(true);
    });
  });

  describe('checkLimit - multiple keys isolation', () => {
    it('should track separate keys independently', async () => {
      const key1 = `${TEST_KEY}:key1`;
      const key2 = `${TEST_KEY}:key2`;
      const limit = 2;

      // Max out key1
      await checkLimit(key1, limit, 60);
      await checkLimit(key1, limit, 60);
      
      let result1 = await checkLimit(key1, limit, 60);
      expect(result1.allowed).toBe(false);

      // key2 should still be available
      let result2 = await checkLimit(key2, limit, 60);
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(1);

      // key2 can reach its own limit
      result2 = await checkLimit(key2, limit, 60);
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(0);

      result2 = await checkLimit(key2, limit, 60);
      expect(result2.allowed).toBe(false);
    });
  });

  describe('checkLimitByTier', () => {
    it('should apply public tier limit (60/min)', async () => {
      const key = `${TEST_KEY}:public`;
      const result = await checkLimitByTier(key, 'public');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(RATE_LIMITS.public - 1);
    });

    it('should apply oracle tier limit (10/min)', async () => {
      const key = `${TEST_KEY}:oracle`;
      const result = await checkLimitByTier(key, 'oracle');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(RATE_LIMITS.oracle - 1);
    });

    it('should apply admin tier limit (20/min)', async () => {
      const key = `${TEST_KEY}:admin`;
      const result = await checkLimitByTier(key, 'admin');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(RATE_LIMITS.admin - 1);
    });

    it('should respect different tier limits for same identifier', async () => {
      const id = `${TEST_KEY}:user123`;

      // Public tier allows 60
      const publicResult = await checkLimitByTier(id, 'public');
      expect(publicResult.remaining).toBe(59);

      // Oracle tier allows 10 (independent counter)
      const oracleResult = await checkLimitByTier(id, 'oracle');
      expect(oracleResult.remaining).toBe(9);

      // Admin tier allows 20 (independent counter)
      const adminResult = await checkLimitByTier(id, 'admin');
      expect(adminResult.remaining).toBe(19);
    });
  });

  describe('resetLimit', () => {
    it('should reset counter to allow new requests', async () => {
      const limit = 2;
      
      // Max out the limit
      await checkLimit(TEST_KEY, limit, 60);
      await checkLimit(TEST_KEY, limit, 60);

      let result = await checkLimit(TEST_KEY, limit, 60);
      expect(result.allowed).toBe(false);

      // Reset
      await resetLimit(TEST_KEY);

      // Should allow requests again
      result = await checkLimit(TEST_KEY, limit, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(limit - 1);
    });

    it('should not affect other keys', async () => {
      const key1 = `${TEST_KEY}:key1`;
      const key2 = `${TEST_KEY}:key2`;
      const limit = 2;

      await checkLimit(key1, limit, 60);
      await checkLimit(key1, limit, 60);
      await checkLimit(key2, limit, 60);

      // Reset key1
      await resetLimit(key1);

      // key1 should be reset
      let result1 = await checkLimit(key1, limit, 60);
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(1);

      // key2 should maintain its state
      let result2 = await checkLimit(key2, limit, 60);
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(0);
    });
  });

  describe('getCurrentCount', () => {
    it('should return accurate count', async () => {
      const limit = 10;
      const requests = 5;

      for (let i = 0; i < requests; i++) {
        await checkLimit(TEST_KEY, limit, 60);
      }

      const count = await getCurrentCount(TEST_KEY);
      expect(count).toBe(requests);
    });

    it('should respect window expiration', async () => {
      const window = 1;

      await checkLimit(TEST_KEY, 10, window);
      await checkLimit(TEST_KEY, 10, window);

      let count = await getCurrentCount(TEST_KEY, window);
      expect(count).toBeGreaterThanOrEqual(1);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      count = await getCurrentCount(TEST_KEY, window);
      expect(count).toBe(0);
    });
  });

  describe('Redis distributed behavior', () => {
    it('should work with concurrent requests from multiple "clients"', async () => {
      const limit = 5;
      const concurrentRequests = 10;

      // Simulate concurrent requests
      const promises = Array(concurrentRequests)
        .fill(null)
        .map(() => checkLimit(TEST_KEY, limit, 60));

      const results = await Promise.all(promises);

      // Exactly 'limit' should be allowed
      const allowed = results.filter((r) => r.allowed).length;
      const rejected = results.filter((r) => !r.allowed).length;

      expect(allowed).toBe(limit);
      expect(rejected).toBe(concurrentRequests - limit);

      // All rejections should have remaining = 0
      results.forEach((r) => {
        if (!r.allowed) {
          expect(r.remaining).toBe(0);
        }
      });
    });

    it('should track requests across multiple windows', async () => {
      const limit = 3;
      const window = 1;

      // First window
      for (let i = 0; i < limit; i++) {
        const result = await checkLimit(TEST_KEY, limit, window);
        expect(result.allowed).toBe(true);
      }

      let result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(false);

      // Wait for first window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Second window - should allow requests again
      for (let i = 0; i < limit; i++) {
        const result = await checkLimit(TEST_KEY, limit, window);
        expect(result.allowed).toBe(true);
      }

      result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle zero remaining correctly', async () => {
      const limit = 1;

      let result = await checkLimit(TEST_KEY, limit, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);

      result = await checkLimit(TEST_KEY, limit, 60);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should handle large limits', async () => {
      const limit = 10000;

      const result = await checkLimit(TEST_KEY, limit, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(limit - 1);
    });

    it('should handle very short windows', async () => {
      const limit = 2;
      const window = 0.1; // 100ms

      let result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(true);

      result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(true);

      result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      result = await checkLimit(TEST_KEY, limit, window);
      expect(result.allowed).toBe(true);
    });

    it('should return reset_at as unix timestamp in seconds', async () => {
      const result = await checkLimit(TEST_KEY, 5, 60);
      
      // Should be a reasonable unix timestamp
      expect(typeof result.reset_at).toBe('number');
      expect(result.reset_at).toBeGreaterThan(1600000000); // After 2020
      expect(result.reset_at).toBeLessThan(2000000000); // Before 2033
    });
  });
});
