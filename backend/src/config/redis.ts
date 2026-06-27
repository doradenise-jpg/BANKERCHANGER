import Redis from 'ioredis';
import { logger } from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, { lazyConnect: true });

// Error event handler - prevents uncaught exception crash
redis.on('error', (err) => {
  logger.error({ err }, 'Redis client error');
});

// Reconnecting event handler - logs reconnection attempts
redis.on('reconnecting', (info) => {
  logger.info({ attempt: info.attempt, delay: info.delay }, 'Redis client reconnecting');
});

// Connection established
redis.on('connect', () => {
  logger.info('Redis client connected');
});

// Connection ready and authenticated
redis.on('ready', () => {
  logger.info('Redis client ready');
});
