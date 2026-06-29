import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/AppError';
import { getEnv } from '../config/env';

export interface AdminJwtPayload extends jwt.JwtPayload {
  role: 'admin';
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminJwtPayload;
    }
  }
}

export function requireAdminJwt(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Missing or invalid Authorization header'));
  }

  const token = authHeader.slice(7);
  const env = getEnv();
  const secret = env.ADMIN_JWT_SECRET;

  try {
    const payload = jwt.verify(token, secret) as AdminJwtPayload;
    if (payload.role !== 'admin') {
      return next(new AppError(403, 'Forbidden: admin role required'));
    }
    req.admin = payload;
    next();
  } catch {
    next(new AppError(403, 'Invalid or expired token'));
  }
}
