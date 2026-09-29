import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as authService from '../services/auth.service';
import { AppError } from '../utils/AppError';
import { getEnv } from '../config/env';

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AppError(401, 'Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    const { JWT_SECRET } = getEnv();
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;

    if (payload.type !== 'access') {
      throw new AppError(401, 'Invalid token type');
    }

    const userId = payload.sub as string;
    const sessionVersion: number = payload.sv ?? 0;
    const passwordVersion: number | undefined = payload.password_version ?? payload.pv;

    const revoked = await authService.isSessionRevoked(userId, sessionVersion, passwordVersion);
    if (revoked) throw new AppError(401, 'Session has been invalidated');

    if (passwordVersion !== undefined) {
      const stale = await authService.isPasswordVersionStale(userId, passwordVersion);
      if (stale) throw new AppError(401, 'Session has been invalidated');
    }

    (req as unknown as Record<string, unknown>).userId = userId;
    (req as unknown as Record<string, unknown>).sessionVersion = sessionVersion;
    if (passwordVersion !== undefined) {
      (req as unknown as Record<string, unknown>).passwordVersion = passwordVersion;
    }
    next();
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(401, 'Invalid or expired token'));
  }
}
