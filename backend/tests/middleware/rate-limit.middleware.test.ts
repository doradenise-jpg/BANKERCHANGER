import type { Request, Response, NextFunction } from 'express';
import { beforeEach, describe, it, expect, jest } from '@jest/globals';

// Mock cache.service before importing middleware
const mockIncr = jest.fn<() => Promise<number>>();
const mockExpire = jest.fn<() => Promise<number>>();
const mockTtl = jest.fn<() => Promise<number>>();

jest.mock('../../src/services/cache.service', () => ({
  redis: { incr: mockIncr, expire: mockExpire, ttl: mockTtl },
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
    mockExpire.mockResolvedValue(1);
    mockTtl.mockResolvedValue(55);
  });

  describe('keyBy: ip', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: 'ip' });

    it('allows requests under the limit', async () => {
      mockIncr.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('allows request exactly at the limit', async () => {
      mockIncr.mockResolvedValue(2);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('returns 429 when limit is exceeded', async () => {
      mockIncr.mockResolvedValue(3);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const err = (next as jest.Mock).mock.calls[0][0] as AppError;
      expect(err.statusCode).toBe(429);
      expect(err.message).toBe('Too Many Requests');
    });

    it('sets Retry-After header on 429', async () => {
      mockIncr.mockResolvedValue(3);
      mockTtl.mockResolvedValue(42);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect((res.set as jest.Mock)).toHaveBeenCalledWith('Retry-After', '42');
    });

    it('sets expire only on first request (count === 1)', async () => {
      mockIncr.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(mockExpire).toHaveBeenCalledWith('rl:/auth/login:1.2.3.4', 60);
    });

    it('does not call expire on subsequent requests', async () => {
      mockIncr.mockResolvedValue(2);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(mockExpire).not.toHaveBeenCalled();
    });
  });

  describe('keyBy: userId', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: 'userId' });

    it('uses user.id as key when present', async () => {
      mockIncr.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      (req as unknown as { user: { id: string } }).user = { id: 'user-42' };
      await mw(req, res, next);
      expect(mockIncr).toHaveBeenCalledWith('rl:/auth/login:user-42');
    });

    it('falls back to IP when user is not set', async () => {
      mockIncr.mockResolvedValue(1);
      const { req, res, next } = makeReqRes('9.9.9.9');
      await mw(req, res, next);
      expect(mockIncr).toHaveBeenCalledWith('rl:/auth/login:9.9.9.9');
    });
  });

  describe('window reset', () => {
    it('allows requests again after window expires (count resets to 1)', async () => {
      const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: 'ip' });
      // Simulate window expired: Redis returns 1 again (key was gone, INCR created it fresh)
      mockIncr.mockResolvedValue(1);
      const { req, res, next } = makeReqRes();
      await mw(req, res, next);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('X-Forwarded-For header handling (trust proxy)', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: 'ip' });

    it('validates req.ip is extracted correctly from X-Forwarded-For', async () => {
      mockIncr.mockResolvedValue(1);
      const req = {
        ip: '203.0.113.5', // Real client IP set by trust proxy from X-Forwarded-For
        path: '/auth/login',
        get: jest.fn((header: string) => {
          if (header === 'X-Forwarded-For') return '203.0.113.5, 10.0.0.1';
          return undefined;
        }),
      } as unknown as Request;
      const res = { set: jest.fn().mockReturnThis() } as unknown as Response;
      const next = jest.fn() as unknown as NextFunction;

      await mw(req, res, next);
      expect(mockIncr).toHaveBeenCalledWith('rl:/auth/login:203.0.113.5');
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('separate rate limit buckets per IP', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2, keyBy: 'ip' });

    it('different IPs get separate rate limit buckets', async () => {
      mockExpire.mockResolvedValue(1);
      mockTtl.mockResolvedValue(55);

      // First IP: 1.2.3.4
      mockIncr.mockResolvedValueOnce(1);
      let { req, res, next } = makeReqRes('1.2.3.4');
      await mw(req, res, next);
      expect(mockIncr).toHaveBeenCalledWith('rl:/auth/login:1.2.3.4');

      // Second IP: 5.6.7.8
      mockIncr.mockResolvedValueOnce(1);
      ({ req, res, next } = makeReqRes('5.6.7.8'));
      await mw(req, res, next);
      expect(mockIncr).toHaveBeenCalledWith('rl:/auth/login:5.6.7.8');

      // First IP again: should increment to 2 (not shared with second IP)
      mockIncr.mockResolvedValueOnce(2);
      ({ req, res, next } = makeReqRes('1.2.3.4'));
      await mw(req, res, next);
      expect(mockIncr).toHaveBeenCalledWith('rl:/auth/login:1.2.3.4');
      expect(next).toHaveBeenLastCalledWith(); // Still within limit (max 2)

      // Second IP again: should increment to 2 (not affected by first IP's limit)
      mockIncr.mockResolvedValueOnce(2);
      ({ req, res, next } = makeReqRes('5.6.7.8'));
      await mw(req, res, next);
      expect(mockIncr).toHaveBeenCalledWith('rl:/auth/login:5.6.7.8');
      expect(next).toHaveBeenLastCalledWith(); // Still within limit (max 2)
    });
  });
});
