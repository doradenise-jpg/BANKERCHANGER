// ============================================================
// BANKERCHANGER — Rate Limiting Service
// Sliding window counter implementation using Redis.
// Works across multiple server instances via Redis.
// ============================================================

import { redis } from '../config/redis';
import { logger } from '../utils/logger';

/**
 * Rate limit tiers with requests per minute
 */
export const RATE_LIMITS = {
  public: 60,     // 60 requests per minute
  oracle: 10,     // 10 requests per minute
  admin: 20,      // 20 requests per minute
} as const;

/**
 * Window size in seconds (1 minute)
 */
const WINDOW_SECONDS = 60;

/**
 * Response from checkLimit
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reset_at: number; // Unix timestamp in seconds
}

/**
 * Check if a request is allowed under rate limit.
 * Uses Redis sliding window counter to track requests.
 *
 * Key format: "ratelimit:{tier}:{key}"
 *
 * Algorithm:
 * 1. Remove all entries older than the window (now - window_seconds)
 * 2. Count entries still in the window
 * 3. If count >= limit, reject (allowed=false)
 * 4. If count < limit, increment and allow (allowed=true)
 * 5. Set TTL on the key to window_seconds to prevent memory leak
 *
 * @param key - Identifier (e.g., user ID, IP address)
 * @param limit - Max requests allowed
 * @param window_seconds - Time window in seconds (default: 60)
 * @returns RateLimitResult with allowed, remaining, and reset_at
 */
export async function checkLimit(
  key: string,
  limit: number,
  window_seconds: number = WINDOW_SECONDS,
): Promise<RateLimitResult> {
  const redisKey = `ratelimit:${key}`;
  const now = Date.now(); // milliseconds
  const windowStartMs = now - window_seconds * 1000; // start of window in ms
  // Redis EXPIRE requires integer seconds, minimum 1
  const ttlSeconds = Math.max(1, Math.ceil(window_seconds));

  try {
    // Execute the sliding window logic atomically via Lua script
    const result = await redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1, // number of keys
      redisKey, // key
      limit.toString(), // limit
      windowStartMs.toString(), // window start in ms
      now.toString(), // current time in ms
      ttlSeconds.toString(), // TTL in seconds
    );

    const [allowed, count, resetAtMs] = result as [number, number, number];

    const remaining = Math.max(0, limit - count);
    const reset_at = Math.floor(resetAtMs / 1000); // convert to seconds

    if (allowed === 1) {
      logger.debug(
        { key, limit, count, remaining, reset_at },
        'ratelimit: Request allowed',
      );
    } else {
      logger.warn(
        { key, limit, count, remaining, reset_at },
        'ratelimit: Request rejected',
      );
    }

    return {
      allowed: allowed === 1,
      remaining,
      reset_at,
    };
  } catch (err) {
    logger.error(
      { err, key, limit, window_seconds },
      'ratelimit: Redis operation failed',
    );
    // On Redis failure, fail open (allow request) to prevent service degradation
    const reset_at = Math.floor((now + window_seconds * 1000) / 1000);
    return {
      allowed: true,
      remaining: limit,
      reset_at,
    };
  }
}

/**
 * Check limit for a specific tier (public, oracle, admin)
 *
 * @param key - Identifier (e.g., user ID, IP address)
 * @param tier - Rate limit tier
 * @returns RateLimitResult
 */
export async function checkLimitByTier(
  key: string,
  tier: keyof typeof RATE_LIMITS,
): Promise<RateLimitResult> {
  const limit = RATE_LIMITS[tier];
  return checkLimit(`${tier}:${key}`, limit, WINDOW_SECONDS);
}

/**
 * Reset rate limit counter for a key (admin operation)
 *
 * @param key - Identifier
 */
export async function resetLimit(key: string): Promise<void> {
  const redisKey = `ratelimit:${key}`;
  try {
    await redis.del(redisKey);
    logger.info({ key }, 'ratelimit: Counter reset');
  } catch (err) {
    logger.error({ err, key }, 'ratelimit: Failed to reset counter');
  }
}

/**
 * Get current count for a key (useful for monitoring)
 *
 * @param key - Identifier
 * @param window_seconds - Time window in seconds
 * @returns Current request count in the window
 */
export async function getCurrentCount(
  key: string,
  window_seconds: number = WINDOW_SECONDS,
): Promise<number> {
  const redisKey = `ratelimit:${key}`;
  const now = Date.now();
  const windowStartMs = now - window_seconds * 1000;

  try {
    const result = await redis.eval(
      COUNT_SCRIPT,
      1,
      redisKey,
      windowStartMs.toString(),
    );
    return (result as number) ?? 0;
  } catch (err) {
    logger.error({ err, key }, 'ratelimit: Failed to get current count');
    return 0;
  }
}

/**
 * Lua script for sliding window counter with atomic increment.
 *
 * Arguments:
 *   KEYS[1] = Redis key (e.g., "ratelimit:user:123")
 *   ARGV[1] = limit (max requests)
 *   ARGV[2] = window start in milliseconds
 *   ARGV[3] = current time in milliseconds
 *   ARGV[4] = TTL in seconds
 *
 * Returns:
 *   [allowed (1 or 0), count, reset_at (ms)]
 *
 * Logic:
 *   1. ZREMRANGEBYSCORE: Remove entries older than window
 *   2. ZCARD: Get count of remaining entries
 *   3. If count >= limit, reject
 *   4. If count < limit, ZADD new entry with unique member and increment count
 *   5. EXPIRE: Set TTL to prevent key from persisting forever
 *   6. ZRANGE: Get min score (oldest timestamp) to calculate reset time
 *   7. Return [allowed, count, reset_at]
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- Remove entries outside the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Count entries in the window
local count = redis.call('ZCARD', key)

-- Check if limit exceeded
if count >= limit then
  -- Limit exceeded, reject
  -- Get the oldest entry (minimum score)
  local entries = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local min_score = tonumber(entries[2]) or now
  local reset_at = min_score + (ttl * 1000)
  return {0, count, reset_at}
end

-- Limit not exceeded, add entry and allow
-- Use a unique member to avoid collision (score + counter)
local counter = redis.call('INCR', key .. ':counter')
redis.call('ZADD', key, now, now .. ':' .. counter)
count = redis.call('ZCARD', key)

-- Set TTL to prevent key from persisting forever
redis.call('EXPIRE', key, ttl)
redis.call('EXPIRE', key .. ':counter', ttl)

-- Calculate reset time (oldest entry + window)
local entries = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local min_score = tonumber(entries[2]) or now
local reset_at = min_score + (ttl * 1000)

return {1, count, reset_at}
`;

/**
 * Lua script to count requests in the window without modifying state.
 *
 * Arguments:
 *   KEYS[1] = Redis key
 *   ARGV[1] = window start in milliseconds
 *
 * Returns:
 *   count of entries in window
 */
const COUNT_SCRIPT = `
local key = KEYS[1]
local window_start = tonumber(ARGV[1])

-- Remove entries outside the window (doesn't affect actual data, just for counting)
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Count entries in the window
local count = redis.call('ZCARD', key)
return count
`;
