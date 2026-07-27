# Distributed Lock TTL Expiry Testing Guide

## Overview

The distributed lock mechanism uses Redis with an automatic expiry time (TTL) to prevent permanent locks if an instance crashes. The `Lock TTL expiry - stale lock recovery` test suite verifies that the system correctly handles lock expiry scenarios, allowing other instances to acquire locks after TTL elapses.

## Problem Addressed

### Original Gap
Previous tests only covered happy paths:
- **Lock acquisition success** — first caller gets lock
- **Lock acquisition failure** — lock already held
- **Concurrent blocking** — two concurrent calls, only one runs

**Missing**: What happens when a lock expires while a job is still running? Can another instance acquire the expired lock?

### Real-World Scenarios
1. **Crashed Instance** — Process A acquires lock with TTL=60s, then crashes without releasing. Should be unblocked after 60s.
2. **Stuck Job** — Long-running job takes 5 minutes but TTL is 2 minutes. Lock expires mid-execution, second instance can start.
3. **Recovery Race** — Multiple instances waiting for stale lock. First one after expiry should win.

## Test Cases

### 1. Basic TTL Expiry and Reacquisition
```typescript
it('should allow second caller to acquire lock after TTL expires', async () => {
  jest.useFakeTimers();
  
  // Caller 1 acquires with 2-second TTL
  const lock1 = await acquireLock({ key: 'expiring-lock', ttl: 2 });
  expect(lock1).not.toBeNull();
  
  // Advance 3 seconds (past 2-second TTL)
  jest.advanceTimersByTime(3000);
  
  // Caller 2 should now acquire the same key
  const lock2 = await acquireLock({ key: 'expiring-lock' });
  expect(lock2).not.toBeNull();
});
```

**Verifies**:
- First caller holds lock for 2 seconds
- After 3 seconds, lock has expired
- Second caller can acquire immediately
- Redis handles TTL automatically (via `EX` flag in SET command)

---

### 2. Long-Running Job with Short TTL
```typescript
it('should handle a long-running job where lock expires mid-execution', async () => {
  // Job with 2-second TTL
  const lock1 = await acquireLock({ ttl: 2 });
  
  // Start job that takes 5 seconds
  const jobPromise = slowJob(); // sleeps 5000ms
  
  // After 2.5 seconds, lock has expired
  jest.advanceTimersByTime(2500);
  
  // Second caller can now acquire
  const lock2 = await acquireLock({ ttl: 60 });
  expect(lock2).not.toBeNull();
  
  // Complete the slow job
  jest.advanceTimersByTime(2500);
  await jobPromise;
});
```

**Verifies**:
- Lock expires during job execution (intended behavior)
- Second instance can start a new "version" of the job
- First instance's release attempt gracefully handles the lock being gone
- No deadlock or blocking occurs

**Real-world use case**: Cron job takes longer than expected, second server's scheduler tries the job, both instances run simultaneously.

---

### 3. Stale Lock from Crashed Instance
```typescript
it('should prevent stale lock from blocking subsequent calls permanently', async () => {
  // Instance A acquires lock with 3-second TTL
  const staleLock = await acquireLock({ 
    key: 'lock', 
    ttl: 3, 
    identifier: 'crashed-instance' 
  });
  
  // Instance A crashes (never releases lock)
  // Advance time past TTL
  jest.advanceTimersByTime(4000);
  
  // Instance B should immediately acquire
  const newLock = await acquireLock({ 
    key: 'lock',
    identifier: 'recovery-instance' 
  });
  
  expect(newLock).not.toBeNull();
  expect(redis.set).toHaveBeenCalledTimes(1); // No retry loop
});
```

**Verifies**:
- Crashed instance doesn't leave permanent lock
- Recovery is automatic (no manual cleanup)
- No polling or retry loops needed
- New instance acquires immediately after TTL

**Real-world use case**: Production incident — container crashes, lock expires after configured TTL, standby instance picks up where first left off.

---

### 4. Wrapped Job with Timeout and Expiry
```typescript
it('should handle wrapped job timeout and lock expiry correctly', async () => {
  const firstJob = jest.fn().mockImplementation(async () => {
    // Simulate stuck job (10 seconds)
    await sleep(10000);
  });
  
  const wrappedFirstJob = withDistributedLock('job', 3, firstJob);
  
  // Start first job with 3-second TTL
  const jobPromise1 = wrappedFirstJob(); // Will take 10s, TTL=3s
  
  // After 4 seconds (1 second past TTL)
  jest.advanceTimersByTime(4000);
  
  // Second instance starts same job successfully
  const secondJob = jest.fn().mockResolvedValue(undefined);
  const wrappedSecondJob = withDistributedLock('job', 60, secondJob);
  
  await wrappedSecondJob();
  
  // Both jobs ran (despite overlapping execution)
  expect(firstJob).toHaveBeenCalledTimes(1);
  expect(secondJob).toHaveBeenCalledTimes(1);
});
```

**Verifies**:
- Wrapped function respects TTL expiry
- Second instance can call `withDistributedLock` after first lock expires
- No race condition or double-execution prevention fails

**Real-world use case**: Cron jobs with uncertain execution time; TTL prevents complete blocking but allows overlap.

## How Jest Fake Timers Work

The tests use `jest.useFakeTimers()` to control time:

```typescript
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it('test', async () => {
  // All setTimeout, Promises, etc. are now controlled by Jest
  jest.advanceTimersByTime(5000); // Jump 5 seconds forward
  // Time-based checks run immediately (no actual waiting)
});
```

**Why this matters**:
- Tests run in milliseconds, not seconds
- TTL expiry is deterministic (no flakiness)
- Can test year-long scenarios instantly

## Implementation Details

### Redis SET Command with TTL
```bash
SET key identifier EX ttl NX
```

- `EX ttl` — Expire the key after `ttl` seconds
- `NX` — Only set if key doesn't exist
- Returns `OK` if set, `null` if key already existed

### Lua Script for Safe Release
```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
```

Ensures only the lock owner (matching identifier) can delete it. Expired locks can't be "stolen" by a release call with the wrong identifier.

## Running the Tests

### Run All TTL Expiry Tests
```bash
npm test -- distributedLock.test.ts -t "Lock TTL expiry"
```

### Run Specific Test
```bash
npm test -- distributedLock.test.ts -t "should allow second caller"
```

### Run With Coverage
```bash
npm test -- --coverage distributedLock.test.ts
```

## Key Assertions

Each test verifies:

| Assertion | Purpose |
|-----------|---------|
| `expect(lock1).not.toBeNull()` | First caller acquired lock |
| `jest.advanceTimersByTime(3000)` | Time has passed TTL |
| `expect(lock2).not.toBeNull()` | Second caller can acquire |
| `expect(redis.eval).toHaveBeenCalled()` | Release was attempted |
| `expect(redis.eval).toHaveReturnedWith(0)` | Lock was already expired |

## TTL Configuration Best Practices

Based on these tests, recommend TTL settings:

| Scenario | TTL | Reasoning |
|----------|-----|-----------|
| Critical job (short) | 5 min | 5-10x expected duration |
| Standard cron job | 30 min | 2-5x expected duration |
| Heavy processing | 2 hours | Allows recovery but prevents indefinite lock |
| Development/testing | 1 min | Catch hangs quickly |

**Formula**: `TTL >= max_expected_execution_time + safety_margin`

If a job consistently runs 10 minutes, set TTL to 15-20 minutes.

## Monitoring Checklist

In production, watch for:

1. **Lock expiry frequency** — If jobs expire before completion, increase TTL
2. **Multiple job instances** — If expiry logs show overlapping execution, tune TTL or job duration
3. **Stale lock recoveries** — Should be rare; frequent recovery = crashed instances
4. **Lock release failures** — Indicates clock skew or Redis issues

Example queries:
```javascript
// Get lock-related error count (from logs)
logs.filter(l => l.key === 'expiring-lock' && l.level === 'warn')

// TTL not long enough if high expiry rate
locks_expired_per_hour / total_jobs_per_hour > 0.05 // Flag if >5%
```

## Limitations & Edge Cases

### What These Tests Don't Cover
- **Clock skew** — If Redis and app clocks drift, TTL may behave unexpectedly
- **Redis failover** — Lock key loss during cluster failover
- **Network partitions** — Partial connectivity may prevent lock release

### Recommended Additional Testing
```typescript
// Integration test: real Redis with real TTL
it('should survive network disconnect and recover', async () => {
  // Requires: real Redis instance
  // Simulate: network partition during execution
  // Verify: second instance recovers after partition heals
});
```

## References

- [Redis SET Command](https://redis.io/commands/set/)
- [Jest Fake Timers](https://jestjs.io/docs/timer-mocks)
- [Distributed Locking Best Practices](https://redis.io/docs/manual/patterns/distributed-locks/)
- [Implementation: src/utils/distributedLock.ts](../src/utils/distributedLock.ts)

## Future Improvements

1. **Add Redis Cluster support** — Test failover scenarios
2. **Extend TTL dynamically** — Job can extend its lock while running
3. **Lock lease renewal** — Keep-alive for long jobs
4. **Metrics** — Export lock wait time, expiry count, etc.

Example extended API:
```typescript
const lock = await acquireLock({ key, ttl: 60 });
// Job is running well, extend deadline
await lock.extend(30); // Add 30 more seconds
```
