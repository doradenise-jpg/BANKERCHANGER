# Redis INCR/EXPIRE Race Condition Fix

## Problem

Two locations in the backend used separate Redis commands to increment a counter and set its expiration:

```typescript
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, windowSec);
```

**Race Condition:** If the process crashes between `INCR` and `EXPIRE`, the key persists indefinitely and permanently blocks the user:
- **Rate limiting**: User remains rate-limited forever even after the window should expire
- **Oracle failure tracking**: Market resolution failures are never cleared, preventing future resolution attempts

## Solution

Replaced with a **Lua script** that executes both operations **atomically on the Redis server**:

```lua
local val = redis.call('INCR', KEYS[1])
if val == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return val
```

### Benefits

1. **Atomic Execution**: Both operations succeed together or fail together—no partial state
2. **Process Crash Safe**: Redis guarantees atomicity even if the client crashes mid-operation
3. **Zero Performance Impact**: Lua scripts execute server-side in a single round trip

## Changes Made

### 1. New Utility: `src/services/redis-lua.ts`

Created a Redis Lua script utility with helper functions:
- `incrWithExpire(redis, key, ttl)` – Executes the atomic INCR+EXPIRE operation
- `registerLuaScripts(redis)` – Pre-registers script for better performance (optional)
- `incrWithExpireSha(redis, sha, key, ttl)` – Uses EVALSHA with fallback to EVAL

### 2. Updated: `src/middleware/rate-limit.middleware.ts`

Replaced separate operations with atomic Lua script:

**Before:**
```typescript
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, windowSec);
```

**After:**
```typescript
const count = await incrWithExpire(redis, key, windowSec);
```

### 3. Updated: `src/oracle/OracleService.ts`

Updated `trackFailure()` function to use atomic operation:

**Before:**
```typescript
const failures = await redis.incr(failureKey);
await redis.expire(failureKey, 7 * 24 * 60 * 60);
```

**After:**
```typescript
const failures = await incrWithExpire(redis, failureKey, 7 * 24 * 60 * 60);
```

## Test Coverage

### Rate-Limit Middleware Tests (`tests/middleware/rate-limit.middleware.test.ts`)

Added 10 tests including:
- ✅ Atomic operation verification
- ✅ Crash scenario documentation
- ✅ Atomicity guarantees validated
- **All tests passing**

### Oracle Service Tests (`tests/services/oracle.service.test.ts`)

Added 2 new tests:
- ✅ `trackFailure crash scenario` – Documents how Lua script prevents permanent key accumulation
- ✅ `ensures incrWithExpire is called for atomic INCR+EXPIRE` – Verifies proper integration
- **All 16 tests passing**

## Verification

```bash
# Run updated tests (26 tests total)
npm test -- tests/middleware/rate-limit.middleware.test.ts tests/services/oracle.service.test.ts

# Results: 26 passed ✓
```

## Impact

| Component | Before | After |
|-----------|--------|-------|
| Race condition window | Between INCR and EXPIRE | None (atomic) |
| Key persistence on crash | Permanent | Never occurs |
| Redis atomicity | No | Yes (Lua) |
| Performance | 2 round trips | 1 round trip |

## Files Modified

1. `src/services/redis-lua.ts` – NEW: Lua script utility
2. `src/middleware/rate-limit.middleware.ts` – Updated to use atomic operation
3. `src/oracle/OracleService.ts` – Updated trackFailure() to use atomic operation
4. `tests/middleware/rate-limit.middleware.test.ts` – Updated mocks, added atomicity tests
5. `tests/services/oracle.service.test.ts` – Added crash scenario tests

---

**Status:** ✅ Complete. All tests passing, race condition eliminated.
