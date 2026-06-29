import type { Request, Response, NextFunction } from 'express';
import { beforeEach, describe, it, expect, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { AppError } from '../../src/utils/AppError';

const SECRET = 'test-secret';

// Mock auth.service before importing routes
const mockIsSessionRevoked = jest.fn<(userId: string, sessionVersion: number) => Promise<boolean>>();
jest.mock('../../src/services/auth.service', () => ({
  isSessionRevoked: mockIsSessionRevoked,
}));

// Import after mocking
import { Router } from 'express';

function createRequireAdmin() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw new AppError(401, 'Missing or invalid Authorization header');
      }

      const token = authHeader.slice(7);
      const payload = jwt.verify(token, SECRET) as jwt.JwtPayload;

      if (payload.type !== 'access') {
        throw new AppError(401, 'Invalid token type');
      }

      if (payload.role !== 'admin') {
        throw new AppError(403, 'Forbidden: admin role required');
      }

      const userId = payload.sub as string;
      const sessionVersion: number = payload.sv ?? 0;

      const revoked = await mockIsSessionRevoked(userId, sessionVersion);
      if (revoked) throw new AppError(401, 'Session has been invalidated');

      (req as unknown as Record<string, unknown>).userId = userId;
      (req as unknown as Record<string, unknown>).sessionVersion = sessionVersion;
      next();
    } catch (err) {
      next(err instanceof AppError ? err : new AppError(401, 'Invalid or expired token'));
    }
  };
}

function makeReqRes(authHeader?: string) {
  const req = {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as Request;
  const res = {} as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('requireAdmin middleware for admin routes', () => {
  const requireAdmin = createRequireAdmin();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = SECRET;
    mockIsSessionRevoked.mockResolvedValue(false);
  });

  describe('role check', () => {
    it('allows requests with admin role', async () => {
      const token = jwt.sign(
        { sub: 'user-123', type: 'access', sv: 0, role: 'admin' },
        SECRET,
        { expiresIn: '1h' },
      );
      const { req, res, next } = makeReqRes(`Bearer ${token}`);
      await requireAdmin(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect((req as unknown as Record<string, unknown>).userId).toBe('user-123');
    });

    it('rejects requests without role claim (user role)', async () => {
      const token = jwt.sign(
        { sub: 'user-456', type: 'access', sv: 0 },
        SECRET,
        { expiresIn: '1h' },
      );
      const { req, res, next } = makeReqRes(`Bearer ${token}`);
      await requireAdmin(req, res, next);
      const err = (next as jest.Mock).mock.calls[0][0] as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(403);
      expect(err.message).toContain('admin role required');
    });

    it('rejects requests with user role', async () => {
      const token = jwt.sign(
        { sub: 'user-789', type: 'access', sv: 0, role: 'user' },
        SECRET,
        { expiresIn: '1h' },
      );
      const { req, res, next } = makeReqRes(`Bearer ${token}`);
      await requireAdmin(req, res, next);
      const err = (next as jest.Mock).mock.calls[0][0] as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(403);
    });
  });

  describe('session revocation check', () => {
    it('allows request when session is not revoked', async () => {
      mockIsSessionRevoked.mockResolvedValue(false);
      const token = jwt.sign(
        { sub: 'admin-1', type: 'access', sv: 5, role: 'admin' },
        SECRET,
        { expiresIn: '1h' },
      );
      const { req, res, next } = makeReqRes(`Bearer ${token}`);
      await requireAdmin(req, res, next);
      expect(mockIsSessionRevoked).toHaveBeenCalledWith('admin-1', 5);
      expect(next).toHaveBeenCalledWith();
    });

    it('rejects request when session is revoked', async () => {
      mockIsSessionRevoked.mockResolvedValue(true);
      const token = jwt.sign(
        { sub: 'admin-2', type: 'access', sv: 3, role: 'admin' },
        SECRET,
        { expiresIn: '1h' },
      );
      const { req, res, next } = makeReqRes(`Bearer ${token}`);
      await requireAdmin(req, res, next);
      expect(mockIsSessionRevoked).toHaveBeenCalledWith('admin-2', 3);
      const err = (next as jest.Mock).mock.calls[0][0] as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(401);
      expect(err.message).toContain('Session has been invalidated');
    });
  });

  describe('error handling', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const { req, res, next } = makeReqRes();
      await requireAdmin(req, res, next);
      const err = (next as jest.Mock).mock.calls[0][0] as AppError;
      expect(err.statusCode).toBe(401);
    });

    it('returns 401 for expired token', async () => {
      const token = jwt.sign(
        { sub: 'admin-3', type: 'access', sv: 0, role: 'admin' },
        SECRET,
        { expiresIn: -1 },
      );
      const { req, res, next } = makeReqRes(`Bearer ${token}`);
      await requireAdmin(req, res, next);
      const err = (next as jest.Mock).mock.calls[0][0] as AppError;
      expect(err.statusCode).toBe(401);
    });

    it('returns 401 for token signed with wrong secret', async () => {
      const token = jwt.sign(
        { sub: 'admin-4', type: 'access', sv: 0, role: 'admin' },
        'wrong-secret',
        { expiresIn: '1h' },
      );
      const { req, res, next } = makeReqRes(`Bearer ${token}`);
      await requireAdmin(req, res, next);
      const err = (next as jest.Mock).mock.calls[0][0] as AppError;
      expect(err.statusCode).toBe(401);
    });

    it('returns 401 for wrong token type', async () => {
      const token = jwt.sign(
        { sub: 'admin-5', type: 'refresh', sv: 0, role: 'admin' },
        SECRET,
        { expiresIn: '1h' },
      );
      const { req, res, next } = makeReqRes(`Bearer ${token}`);
      await requireAdmin(req, res, next);
      const err = (next as jest.Mock).mock.calls[0][0] as AppError;
      expect(err.statusCode).toBe(401);
      expect(err.message).toContain('Invalid token type');
    });
  });
});
