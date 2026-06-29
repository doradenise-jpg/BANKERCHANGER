import cors from 'cors';
import { getEnv } from './env';
import { logger } from '../utils/logger';

/**
 * Parses ALLOWED_ORIGINS from environment variable
 * Supports comma-separated list: "http://localhost:3000,https://app.example.com"
 */
function parseAllowedOrigins(): string[] {
  const env = getEnv();
  const origins = env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  
  if (origins.length === 0) {
    logger.warn('ALLOWED_ORIGINS is empty or invalid, defaulting to http://localhost:3000');
    return ['http://localhost:3000'];
  }
  
  return origins;
}

/**
 * Creates configured CORS middleware with explicit origin allowlist
 * 
 * Features:
 * - Explicit origin allowlist from ALLOWED_ORIGINS env variable
 * - Restricted HTTP methods: GET, POST, PUT, DELETE, OPTIONS
 * - Credentials support enabled
 * - Preflight caching for 1 hour
 */
export function createCorsMiddleware() {
  const allowedOrigins = parseAllowedOrigins();
  
  logger.info({ allowedOrigins }, 'CORS configured with allowed origins');

  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn({ origin, allowedOrigins }, 'CORS: Origin not allowed');
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
    maxAge: 3600, // Preflight cache for 1 hour
  });
}

/**
 * Get the list of allowed origins (for testing and debugging)
 */
export function getAllowedOrigins(): string[] {
  return parseAllowedOrigins();
}
