import { redis } from '../config/redis';
import { logger } from './logger';

export interface LockOptions {
  /**
   * Lock key name
   */
  key: string;
  /**
   * Time-to-live in seconds
   */
  ttl: number;
  /**
   * Unique identifier for this lock acquisition (defaults to random)
   */
  identifier?: string;
}

export interface Lock {
  key: string;
  identifier: string;
  release: () => Promise<void>;
}

/**
 * Acquires a distributed lock using Redis SET NX EX pattern
 * @param options Lock configuration
 * @returns Lock object if acquired, null if lock is already held
 */
export async function acquireLock(options: LockOptions): Promise<Lock | null> {
  const { key, ttl, identifier = generateIdentifier() } = options;

  try {
    // SET key identifier NX EX ttl
    // NX = only set if key doesn't exist
    // EX = set expiry time in seconds
    const result = await redis.set(key, identifier, 'EX', ttl, 'NX');

    if (result === 'OK') {
      logger.debug({ key, identifier, ttl }, 'Distributed lock acquired');

      return {
        key,
        identifier,
        release: async () => {
          await releaseLock(key, identifier);
        },
      };
    }

    // Lock already held by another instance
    logger.debug({ key }, 'Distributed lock already held by another instance');
    return null;
  } catch (err) {
    logger.error({ err, key }, 'Failed to acquire distributed lock');
    return null;
  }
}

/**
 * Releases a distributed lock using Lua script to ensure atomic check-and-delete
 * @param key Lock key
 * @param identifier Lock identifier to verify ownership
 */
async function releaseLock(key: string, identifier: string): Promise<void> {
  try {
    // Lua script ensures we only delete the lock if we own it
    // This prevents accidentally releasing another instance's lock
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await redis.eval(luaScript, 1, key, identifier);

    if (result === 1) {
      logger.debug({ key, identifier }, 'Distributed lock released');
    } else {
      logger.warn({ key, identifier }, 'Lock not released - already expired or owned by another instance');
    }
  } catch (err) {
    logger.error({ err, key, identifier }, 'Failed to release distributed lock');
  }
}

/**
 * Generates a unique identifier for lock ownership
 */
function generateIdentifier(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Wraps a cron job function with distributed locking
 * @param jobName Name of the job (used for lock key)
 * @param ttl Lock TTL in seconds (should be longer than job execution time)
 * @param fn Job function to execute
 * @returns Wrapped function with distributed locking
 */
export function withDistributedLock(
  jobName: string,
  ttl: number,
  fn: () => Promise<void>
): () => Promise<void> {
  return async () => {
    const lockKey = `cron:lock:${jobName}`;
    const lock = await acquireLock({ key: lockKey, ttl });

    if (!lock) {
      logger.debug({ jobName }, 'Skipping cron job - lock held by another instance');
      return;
    }

    try {
      await fn();
    } catch (err) {
      logger.error({ err, jobName }, 'Cron job failed');
      throw err;
    } finally {
      await lock.release();
    }
  };
}
