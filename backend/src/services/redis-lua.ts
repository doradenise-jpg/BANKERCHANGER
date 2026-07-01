// ============================================================
// Redis Lua Script Utility
// Atomic operations using Lua scripts to prevent race conditions
// ============================================================

import type Redis from 'ioredis';
import { logger } from '../utils/logger';

/**
 * Lua script for atomic INCR + EXPIRE operation.
 * 
 * Returns the new incremented value.
 * If the value is 1 (meaning the key was just created), sets the expiration.
 * 
 * @param key - The Redis key to increment
 * @param ttl - Time to live in seconds (only set if key is new)
 * 
 * Equivalent to:
 *   local val = redis.call('INCR', key)
 *   if val == 1 then
 *     redis.call('EXPIRE', key, ttl)
 *   end
 *   return val
 */
const INCR_EXPIRE_SCRIPT = `
local val = redis.call('INCR', KEYS[1])
if val == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return val
`;

/**
 * Loads and executes the INCR + EXPIRE Lua script atomically.
 * 
 * If process crashes between INCR and EXPIRE (separate commands),
 * the key persists forever. This Lua script ensures both operations
 * happen atomically on the Redis side.
 * 
 * @param redis - ioredis client instance
 * @param key - The Redis key to increment
 * @param ttl - Time to live in seconds (only set when key is first created)
 * @returns The new incremented value (always >= 1)
 * 
 * @throws If Redis operation fails
 */
export async function incrWithExpire(
  redis: Redis,
  key: string,
  ttl: number,
): Promise<number> {
  try {
    // EVAL key count key1 arg1 arg2 ...
    // We have 1 key and 1 arg (the TTL)
    const result = await redis.eval(INCR_EXPIRE_SCRIPT, 1, key, ttl);
    return result as number;
  } catch (err) {
    logger.error({ err, key, ttl }, 'incrWithExpire: Redis Lua script failed');
    throw err;
  }
}

/**
 * Registers the Lua script with Redis for optimal performance.
 * Returns the SHA1 hash of the script for later use via EVALSHA.
 * 
 * Note: This is optional. redis.eval() will automatically load the script
 * if not already cached, but pre-registering can improve performance
 * in high-throughput scenarios.
 * 
 * @param redis - ioredis client instance
 * @returns SHA1 hash of the script
 */
export async function registerLuaScripts(redis: Redis): Promise<string> {
  try {
    const sha = await redis.script('LOAD', INCR_EXPIRE_SCRIPT);
    logger.debug({ sha }, 'registerLuaScripts: INCR_EXPIRE script registered');
    return sha as string;
  } catch (err) {
    logger.error({ err }, 'registerLuaScripts: Failed to register Lua scripts');
    throw err;
  }
}

/**
 * Executes the INCR + EXPIRE Lua script using EVALSHA for better performance.
 * Falls back to EVAL if the script is not loaded.
 * 
 * @param redis - ioredis client instance
 * @param sha - SHA1 hash of the script
 * @param key - The Redis key to increment
 * @param ttl - Time to live in seconds
 * @returns The new incremented value
 * 
 * @throws If Redis operation fails
 */
export async function incrWithExpireSha(
  redis: Redis,
  sha: string,
  key: string,
  ttl: number,
): Promise<number> {
  try {
    const result = await redis.evalsha(sha, 1, key, ttl);
    return result as number;
  } catch (err: any) {
    // NOSCRIPT error means script not loaded, fall back to EVAL
    if (err.message && err.message.includes('NOSCRIPT')) {
      logger.debug({ sha }, 'incrWithExpireSha: Script not in cache, falling back to EVAL');
      return incrWithExpire(redis, key, ttl);
    }
    logger.error({ err, key, ttl }, 'incrWithExpireSha: Redis Lua script failed');
    throw err;
  }
}
