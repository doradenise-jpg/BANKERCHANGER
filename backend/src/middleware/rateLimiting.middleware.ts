// ============================================================
// Rate Limiting Middleware
// Express middleware for applying rate limits to routes
// ============================================================

import { Request, Response, NextFunction } from 'express';
import { checkLimitByTier } from '../services/rateLimiting.service';
import { logger } from '../utils/logger';

/**
 * Extract the rate limit key from the request.
 * Priority: authenticated user ID > API key > IP address
 */
function getRateLimitKey(req: Request & { user?: { id: string }; apiKey?: string }): string {
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }
  if (req.apiKey) {
    return `apikey:${req.apiKey}`;
  }
  return `ip:${req.ip || 'unknown'}`;
}

/**
 * Determine the rate limit tier based on user/API key.
 * This should be customized based on your business logic.
 */
function getRateLimitTier(
  req: Request & { user?: { id: string; tier?: string }; apiKey?: string },
): 'public' | 'oracle' | 'admin' {
  // If user has a tier, use it
  if (req.user?.tier === 'admin') {
    return 'admin';
  }
  if (req.user?.tier === 'oracle') {
    return 'oracle';
  }

  // Default to public for unauthenticated or standard users
  return 'public';
}

/**
 * Rate limiting middleware factory.
 * Creates a middleware that applies rate limits to requests.
 *
 * @param options - Configuration options
 *   - keyExtractor: Function to extract rate limit key from request (default: getKey)
 *   - tierExtractor: Function to extract tier from request (default: getTier)
 *
 * @returns Express middleware
 *
 * @example
 * // Apply to all API routes
 * app.use('/api/', rateLimitingMiddleware());
 *
 * // Apply to specific endpoint
 * app.post('/api/submit-bet', rateLimitingMiddleware(), submitBetHandler);
 */
export function rateLimitingMiddleware(options?: {
  keyExtractor?: (req: Request) => string;
  tierExtractor?: (req: Request) => 'public' | 'oracle' | 'admin';
}) {
  const extractKey = options?.keyExtractor || getRateLimitKey;
  const extractTier = options?.tierExtractor || getRateLimitTier;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = extractKey(req);
      const tier = extractTier(req);

      const result = await checkLimitByTier(key, tier);

      // Add rate limit headers
      res.set({
        'X-RateLimit-Limit': '60', // This should match the tier limit
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': result.reset_at.toString(),
      });

      if (!result.allowed) {
        logger.warn(
          { key, tier, reset_at: result.reset_at },
          'rateLimitingMiddleware: Request rejected',
        );
        return res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please try again later.',
          reset_at: result.reset_at,
          retry_after: result.reset_at - Math.floor(Date.now() / 1000),
        });
      }

      next();
    } catch (err) {
      logger.error({ err }, 'rateLimitingMiddleware: Unexpected error');
      // Fail open - allow request if rate limiting service fails
      next();
    }
  };
}

/**
 * Per-endpoint rate limit middleware.
 * Allows specifying different limits for different endpoints.
 *
 * @param limit - Maximum requests
 * @param window_seconds - Time window in seconds
 * @returns Express middleware
 *
 * @example
 * // Allow 10 requests per minute for /api/expensive-operation
 * app.post('/api/expensive-operation',
 *   perEndpointRateLimit(10, 60),
 *   expensiveOperationHandler
 * );
 */
export function perEndpointRateLimit(limit: number, window_seconds: number = 60) {
  const { checkLimit } = require('../services/rateLimiting.service');

  return async (req: Request & { user?: { id: string } }, res: Response, next: NextFunction) => {
    try {
      const key = getRateLimitKey(req);
      const result = await checkLimit(key, limit, window_seconds);

      res.set({
        'X-RateLimit-Limit': limit.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': result.reset_at.toString(),
      });

      if (!result.allowed) {
        logger.warn({ key, limit }, 'perEndpointRateLimit: Request rejected');
        return res.status(429).json({
          error: 'Too Many Requests',
          message: `This operation is limited to ${limit} requests per ${window_seconds} seconds.`,
          reset_at: result.reset_at,
        });
      }

      next();
    } catch (err) {
      logger.error({ err }, 'perEndpointRateLimit: Unexpected error');
      // Fail open
      next();
    }
  };
}
