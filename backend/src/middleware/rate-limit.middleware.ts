import type { Request, Response, NextFunction } from 'express';
import { redis } from '../services/cache.service';
import { incrWithExpire } from '../services/redis-lua';
import { AppError } from '../utils/AppError';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyBy: 'ip' | 'userId';
}

export function rateLimit(opts: RateLimitOptions) {
  const windowSec = Math.ceil(opts.windowMs / 1000);

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const id =
      opts.keyBy === 'userId'
        ? (req as Request & { user?: { id: string } }).user?.id ?? req.ip
        : req.ip;

    const key = `rl:${req.path}:${id}`;

    // Use atomic Lua script to prevent race condition between INCR and EXPIRE
    const count = await incrWithExpire(redis, key, windowSec);

    if (count > opts.max) {
      const ttl = await redis.ttl(key);
      (_res as Response).set('Retry-After', String(ttl));
      return next(new AppError(429, 'Too Many Requests'));
    }

    next();
  };
}
