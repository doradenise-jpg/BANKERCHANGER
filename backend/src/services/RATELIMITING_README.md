# Rate Limiting Service

A Redis-based rate limiting service using sliding window counter algorithm. Supports distributed rate limiting across multiple server instances and multiple rate limit tiers.

## Overview

The service tracks API requests per unique key within a time window using a Redis sorted set (ZSET). The sliding window counter algorithm ensures accurate rate limiting without false positives or negatives.

**Key Features:**
- ✅ Sliding window counter implementation (not fixed window)
- ✅ Atomic operations via Lua scripts (no race conditions)
- ✅ Works across multiple server instances (Redis-based)
- ✅ Three predefined tiers: public (60/min), oracle (10/min), admin (20/min)
- ✅ Returns remaining quota and reset timestamp
- ✅ Automatic memory cleanup via TTL
- ✅ Graceful fallback on Redis unavailability

## Installation

The service is included in the backend. Redis must be running and accessible via the `REDIS_URL` environment variable (default: `redis://localhost:6379`).

## Usage

### Basic Usage

```typescript
import { checkLimit } from '../services/rateLimiting.service';

// Check rate limit for a custom key
const result = await checkLimit('user:123:api', 100, 60); // 100 requests per 60 seconds

if (result.allowed) {
  console.log(`Request allowed. Remaining: ${result.remaining}`);
  // Process request
} else {
  console.log(`Rate limit exceeded. Resets at: ${new Date(result.reset_at * 1000)}`);
  // Return 429 Too Many Requests
}
```

### Using Predefined Tiers

```typescript
import { checkLimitByTier } from '../services/rateLimiting.service';

// Public API (60 requests/minute)
let result = await checkLimitByTier('client:ip:192.168.1.1', 'public');

// Oracle API (10 requests/minute)
result = await checkLimitByTier('user:123', 'oracle');

// Admin API (20 requests/minute)
result = await checkLimitByTier('admin:456', 'admin');
```

### Express Middleware Example

```typescript
import { Response, NextFunction } from 'express';
import { checkLimitByTier } from '../services/rateLimiting.service';

export async function rateLimitMiddleware(
  req: Request & { user?: { id: string } },
  res: Response,
  next: NextFunction,
) {
  const tier = req.user?.id ? 'authenticated' : 'public';
  const key = req.user?.id || req.ip;
  
  const result = await checkLimitByTier(key, tier);
  
  // Add headers
  res.set('X-RateLimit-Limit', limit.toString());
  res.set('X-RateLimit-Remaining', result.remaining.toString());
  res.set('X-RateLimit-Reset', result.reset_at.toString());
  
  if (!result.allowed) {
    return res.status(429).json({
      error: 'Too Many Requests',
      reset_at: result.reset_at,
    });
  }
  
  next();
}
```

## API Reference

### `checkLimit(key, limit, window_seconds)`

Check if a request is allowed under rate limit.

**Parameters:**
- `key` (string): Unique identifier (user ID, IP address, API key, etc.)
- `limit` (number): Maximum requests allowed in the window
- `window_seconds` (number, optional): Time window in seconds (default: 60)

**Returns:** `RateLimitResult`
```typescript
{
  allowed: boolean;        // true if request is allowed
  remaining: number;       // requests remaining in current window
  reset_at: number;        // unix timestamp (seconds) when window resets
}
```

**Example:**
```typescript
const result = await checkLimit('api-key-abc123', 1000, 3600);
// Allow 1000 requests per hour
```

### `checkLimitByTier(key, tier)`

Check rate limit using a predefined tier.

**Parameters:**
- `key` (string): Unique identifier
- `tier` ('public' | 'oracle' | 'admin'): Rate limit tier

**Tier Limits:**
- `public`: 60 requests/minute
- `oracle`: 10 requests/minute
- `admin`: 20 requests/minute

**Example:**
```typescript
const result = await checkLimitByTier('user@example.com', 'public');
```

### `resetLimit(key)`

Manually reset a rate limit counter (admin operation).

**Parameters:**
- `key` (string): Unique identifier

**Example:**
```typescript
// Allow a user to retry immediately
await resetLimit('user:123:api');
```

### `getCurrentCount(key, window_seconds)`

Get the current request count in the window (for monitoring).

**Parameters:**
- `key` (string): Unique identifier
- `window_seconds` (number, optional): Time window in seconds (default: 60)

**Returns:** `number` - Current request count

**Example:**
```typescript
const count = await getCurrentCount('user:123');
console.log(`User has made ${count} requests this minute`);
```

## Algorithm Details

### Sliding Window Counter

The service uses a Redis sorted set (ZSET) to track request timestamps within a window:

1. **Store requests**: Each request is stored as a member in a sorted set, scored by timestamp
2. **Expire old entries**: On each check, entries older than the window are removed
3. **Count current**: Remaining entries are counted against the limit
4. **Allow/Deny**: If count < limit, add new entry; otherwise, reject

**Advantages over fixed window:**
- Prevents "thundering herd" at window boundaries
- More accurate rate limiting
- Distributes request bursts evenly

### Atomic Operations

All operations are executed atomically via Lua script to prevent race conditions across multiple server instances:

```lua
-- Remove entries outside window
ZREMRANGEBYSCORE key -inf window_start

-- Count entries in window
count = ZCARD key

-- If under limit, add new entry
if count < limit then
  ZADD key now member
  EXPIRE key ttl
end
```

This ensures that multiple requests from different servers cannot exceed the limit.

## Redis Data Structure

Each rate limit counter uses a Redis sorted set:

**Key format:** `ratelimit:{key}`
**Member:** Unique identifier (timestamp + counter)
**Score:** Millisecond timestamp of the request

**TTL:** Automatically set to the window duration to prevent memory leaks

**Example Redis state:**
```
ratelimit:user:123 (ZSET)
  1700000000:1 → 1700000000
  1700000001:2 → 1700000001
  1700000002:3 → 1700000002
  (expires in 60 seconds)
```

## Monitoring

### Metrics

The service logs at DEBUG level for allowed requests and WARN level for rejected requests:

```json
{
  "level": "debug",
  "key": "user:123",
  "limit": 60,
  "count": 5,
  "remaining": 55,
  "reset_at": 1700000060,
  "msg": "ratelimit: Request allowed"
}
```

### Error Handling

If Redis is unavailable, the service fails open (allows requests) to prevent service degradation. This is logged as an error:

```json
{
  "level": "error",
  "key": "user:123",
  "err": { "message": "ECONNREFUSED" },
  "msg": "ratelimit: Redis operation failed"
}
```

## Performance

- **Time Complexity**: O(log N) where N is the number of requests in the window
- **Space Complexity**: O(N) where N is the number of requests in the window
- **Latency**: ~1-5ms per check (single Redis operation)

## Testing

Run the test suite:

```bash
npm test -- tests/services/rateLimiting.service.test.ts
```

The tests cover:
- ✅ Basic rate limiting (allow/reject)
- ✅ Sliding window behavior
- ✅ Multiple key isolation
- ✅ Tier limits
- ✅ Counter reset
- ✅ Concurrent requests
- ✅ Window expiration
- ✅ Edge cases (zero remaining, large limits, short windows)

## Limitations

1. **Redis dependency**: Service fails gracefully if Redis is unavailable
2. **Precision**: Timestamps are in milliseconds; microsecond precision not supported
3. **Memory**: Stores one entry per request within the window (not suitable for very high limits + short windows)
4. **Fairness**: Does not guarantee fair distribution of requests across clients

## Future Enhancements

- Token bucket algorithm for burst handling
- Dynamic tier adjustment based on user plan
- Persistent rate limit history
- Geographic rate limiting
- DDoS protection integration

## Troubleshooting

### "Rate limit exceeded" immediately

**Cause**: User may have been rate limited in a previous window that hasn't expired.
**Solution**: Call `resetLimit(key)` to clear the counter.

### High Redis memory usage

**Cause**: TTL not being set properly on old keys.
**Solution**: Check Redis logs for EXPIRE failures; ensure EXPIRE command is working.

### Inconsistent rate limit between servers

**Cause**: Each server might have a different time offset.
**Solution**: Ensure NTP is synchronized across all servers; Redis uses server time.

## References

- [Redis ZSET Documentation](https://redis.io/commands/zadd)
- [Sliding Window Counter Algorithm](https://en.wikipedia.org/wiki/Sliding_window#Packet_loss)
- [Rate Limiting Strategies](https://cloud.google.com/architecture/rate-limiting-strategies-techniques)
