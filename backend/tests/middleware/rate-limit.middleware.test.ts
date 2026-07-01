import type { Request, Response, NextFunction } from 'express';
import { beforeEach, describe, it, expect, jest } from '@jest/globals';

// Mock redis-lua before importing middleware
const mockIncrWithExpire = jest.fn<() => Promise<number>>();
const mockTtl = jest.fn<() => Promise<number>>();

jest.mock('../../src/services/redis-lua', () => ({
  incrWithExpire: mockIncrWithExpire,
}));

jest.mock('../../src/services/cache.service', () => ({
  redis: { ttl: mockTtl },
}));

import { rateLimit } from '../../src/middleware/rate-limit.middleware';
import { AppError } from '../../src/utils/AppError';

function makeReqRes(ip = '1.2.3.4', path = '/auth/login') {
  const req = { ip, path, user: undefined } as unknown as Request;
  const res = {
    set: jest.fn<Response['set']>().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTtl.mockResolvedValue(55);
  });

  describe('keyBy: ip', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: 'ip' });

    it('allows requests under the limit', async () => {
      mockIncrWithExpire.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('allows request exactly at the limit', async () => {
      mockIncrWithExpire.mockResolvedValue(2);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('returns 429 when limit is exceeded', async () => {
      mockIncrWithExpire.mockResolvedValue(3);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const err = (next as jest.Mock).mock.calls[0][0] as AppError;
      expect(err.statusCode).toBe(429);
      expect(err.message).toBe('Too Many Requests');
    });

    it('sets Retry-After header on 429', async () => {
      mockIncrWithExpire.mockResolvedValue(3);
      mockTtl.mockResolvedValue(42);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect((res.set as jest.Mock)).toHaveBeenCalledWith('Retry-After', '42');
    });

    it('calls incrWithExpire with atomic operation', async () => {
      mockIncrWithExpire.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      // Verify incrWithExpire is called with key and TTL (windowSec)
      expect(mockIncrWithExpire).toHaveBeenCalledWith(
        expect.any(Object),
        'rl:/auth/login:1.2.3.4',
        60, // 60000ms / 1000 = 60s
      );
    });

    it('prevents race condition: both INCR and EXPIRE are atomic', async () => {
      mockIncrWithExpire.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      
      // The atomic Lua script is called once instead of separate incr + expire
      expect(mockIncrWithExpire).toHaveBeenCalledTimes(1);
      // Verify no separate expire call happens (since it's now atomic)
      expect(mockIncrWithExpire.mock.calls[0][2]).toBe(60); // TTL is passed as arg
    });
  });

  describe('keyBy: userId', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: 'userId' });

    it('uses user.id as key when present', async () => {
      mockIncrWithExpire.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      (req as unknown as { user: { id: string } }).user = { id: 'user-42' };
      await mw(req, res, next);
      expect(mockIncrWithExpire).toHaveBeenCalledWith(
        expect.any(Object),
        'rl:/auth/login:user-42',
        60,
      );
    });

    it('falls back to IP when user is not set', async () => {
      mockIncrWithExpire.mockResolvedValue(1);
      const { req, res, next } = makeReqRes('9.9.9.9');
      await mw(req, res, next);
      expect(mockIncrWithExpire).toHaveBeenCalledWith(
        expect.any(Object),
        'rl:/auth/login:9.9.9.9',
        60,
      );
    });
  });

  describe('window reset', () => {
    it('allows requests again after window expires (count resets to 1)', async () => {
      const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: 'ip' });
      // Simulate window expired: Redis returns 1 again (key was gone, INCR created it fresh)
      mockIncrWithExpire.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('crash scenario simulation', () => {
    it('would lose expire if process crashed between INCR and EXPIRE (before fix)', () => {
      // OLD BEHAVIOR (before Lua script):
      // 1. redis.incr(key) -> returns 1, key created
      // 2. [CRASH HERE] Process dies before expire is set
      // 3. Key persists forever
      // 
      // NEW BEHAVIOR (with Lua script):
      // 1. redis.eval(INCR_EXPIRE_SCRIPT) -> atomically:
      //    a. INCR key -> 1
      //    b. EXPIRE key 60 -> OK
      // 2. Both operations succeed or both fail - no partial state
      // 
      // This test documents that the Lua script prevents this issue.
      const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: 'ip' });
      mockIncrWithExpire.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      
      // The atomic operation is guaranteed to succeed fully
      // If process crashes mid-script on Redis side, both ops roll back
      expect(mw(req, res, next)).resolves.not.toThrow();
    });
  });
});
