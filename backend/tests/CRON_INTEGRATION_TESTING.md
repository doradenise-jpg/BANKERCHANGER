# Cron Scheduler Integration Testing Guide

## Overview

The `autoResolution.integration.test.ts` integration tests verify that the cron scheduler correctly schedules, fires, and completes jobs within expected intervals. These tests simulate the behavior of `node-cron` and verify the scheduling logic end-to-end.

## Problem Addressed

### Original Gap
Previous testing only verified individual job functions:
- `runAutoResolutionJob()` tests in isolation
- `runAutoLockMarketsJob()` tests in isolation

**Missing**: Does the cron scheduler actually fire the jobs on schedule? Can jobs run concurrently without deadlock? Are running flags properly reset?

### Real-World Scenarios
1. **Job Overlaps** — Previous resolution job still running when next 10-minute interval fires
2. **Concurrent Jobs** — Resolution (every 10 min) and lock (every 60 sec) fire simultaneously
3. **Error Recovery** — Job throws error; next interval should fire normally
4. **Disable Mechanism** — Environment variable disables scheduler

## Test Architecture

### Mocking Strategy

The tests use a **mock cron module** to replace the real `node-cron` scheduler:

```typescript
jest.mock('node-cron', () => ({
  schedule: jest.fn((pattern: string, callback: () => void) => {
    // Store callback for manual invocation in tests
    mockScheduledTasks.set(taskId, null);
    return { start: jest.fn(), stop: jest.fn(), destroy: jest.fn() };
  }),
}));
```

**Why mock instead of real cron?**
- Real scheduler would require actual time delays (slow tests)
- Can't reliably test 10-minute intervals in unit test timeframe
- Mocking lets us invoke callbacks synchronously

## Test Cases

### 1. Schedule Verification

```typescript
it('should schedule cron job with 10-minute interval', () => {
  startAutoResolutionCron();

  const [pattern] = cron.schedule.mock.calls[0];
  expect(pattern).toBe('*/10 * * * *');
});
```

**Verifies**: Correct cron pattern is registered

---

### 2. Job Execution on Fire

```typescript
it('should call runAutoResolutionJob when cron fires', async () => {
  startAutoResolutionCron();

  const [, callback] = cron.schedule.mock.calls[0];
  await callback(); // Manually invoke cron callback

  expect(runAutoResolutionJob).toHaveBeenCalledTimes(1);
});
```

**Verifies**: Job function is invoked when scheduler fires

---

### 3. Success Logging

```typescript
it('should log success when job completes', async () => {
  (runAutoResolutionJob as jest.Mock).mockResolvedValue({
    processed: 5,
    resolved: 3,
    failed: 0,
  });

  startAutoResolutionCron();
  const [, callback] = cron.schedule.mock.calls[0];
  await callback();

  expect(logger.info).toHaveBeenCalledWith(
    expect.objectContaining({ processed: 5 }),
    expect.stringContaining('completed'),
  );
});
```

**Verifies**: Statistics are logged on completion

---

### 4. Preventing Overlapping Execution

```typescript
it('should skip execution if previous run is still in progress', async () => {
  let resolveFirstRun: (() => void) | null = null;
  (runAutoResolutionJob as jest.Mock).mockImplementation(
    () => new Promise((resolve) => { resolveFirstRun = resolve; })
  );

  startAutoResolutionCron();
  const [, callback] = cron.schedule.mock.calls[0];

  // Start first run (hangs)
  const firstRunPromise = callback();

  // Fire again before first completes
  callback();

  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('previous run still in progress'),
  );
  expect(runAutoResolutionJob).toHaveBeenCalledTimes(1); // Only once
});
```

**Verifies**: 
- Running flag prevents concurrent execution
- Skip is logged
- Job is not called twice

---

### 5. Error Handling

```typescript
it('should log error and continue if runAutoResolutionJob throws', async () => {
  const testError = new Error('RPC connection failed');
  (runAutoResolutionJob as jest.Mock).mockRejectedValue(testError);

  startAutoResolutionCron();
  const [, callback] = cron.schedule.mock.calls[0];
  await callback();

  expect(logger.error).toHaveBeenCalledWith(
    expect.objectContaining({ err: testError }),
    expect.stringContaining('fatal error'),
  );
});
```

**Verifies**: Errors don't crash the scheduler, are logged properly

---

### 6. Running Flag Reset

```typescript
it('should reset running flag even if job throws', async () => {
  (runAutoResolutionJob as jest.Mock).mockRejectedValue(new Error('DB error'));

  startAutoResolutionCron();
  const [, callback] = cron.schedule.mock.calls[0];

  // First call throws
  await callback();

  // Second call should execute (flag was reset in finally)
  (runAutoResolutionJob as jest.Mock).mockClear();
  (runAutoResolutionJob as jest.Mock).mockResolvedValue({
    processed: 0, resolved: 0, failed: 0
  });

  await callback();

  expect(runAutoResolutionJob).toHaveBeenCalledTimes(1);
});
```

**Verifies**: 
- Error doesn't leave `isResolutionRunning = true` permanently
- Next execution can proceed

---

### 7. Disable Mechanism

```typescript
it('should be disabled when AUTO_RESOLUTION_CRON_DISABLED is true', () => {
  process.env.AUTO_RESOLUTION_CRON_DISABLED = 'true';

  startAutoResolutionCron();

  expect(cron.schedule).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith(
    expect.stringContaining('Auto-resolution cron job is disabled'),
  );
});
```

**Verifies**: Environment variable disables scheduler without errors

---

### 8. Concurrent Job Independence

```typescript
it('should not block lock job if resolution job is running', async () => {
  let resolveResolution: (() => void) | null = null;
  (runAutoResolutionJob as jest.Mock).mockImplementation(
    () => new Promise((resolve) => { resolveResolution = resolve; })
  );

  startAutoResolutionCron();
  startAutoLockCron();

  const [, resolutionCallback] = cron.schedule.mock.calls[0];
  const [, lockCallback] = cron.schedule.mock.calls[1];

  // Start resolution (hangs)
  const resolutionPromise = resolutionCallback();

  // Lock should execute immediately
  (runAutoLockMarketsJob as jest.Mock).mockResolvedValue({ locked: 1, failed: 0 });
  await lockCallback();

  expect(runAutoLockMarketsJob).toHaveBeenCalledTimes(1);
});
```

**Verifies**: Different cron jobs have independent running flags

---

## Running the Tests

### Run All Auto-Resolution Tests
```bash
npm test -- autoResolution.integration.test.ts
```

### Run Specific Test Suite
```bash
npm test -- autoResolution.integration.test.ts -t "startAutoResolutionCron"
```

### Run With Coverage
```bash
npm test -- --coverage autoResolution.integration.test.ts
```

### Watch Mode (Development)
```bash
npm test -- autoResolution.integration.test.ts --watch
```

## Key Invariants Verified

| Invariant | Test | Verification |
|-----------|------|--------------|
| Correct cron pattern | Schedule Verification | Pattern matches config (10min / 1min) |
| Job fires on schedule | Job Execution | Callback invoked when triggered |
| No concurrent execution | Overlapping Execution | Skip logged, job called once |
| Error doesn't crash | Error Handling | Exception caught, logged, next interval works |
| Flag cleanup | Running Flag Reset | Finally block resets flag |
| Disable support | Disable Mechanism | Env var prevents schedule |
| Job independence | Concurrent Jobs | Two jobs don't block each other |

## Real-World Scenario: Market Resolution Loop

**Setup**:
```typescript
// Market scheduled to resolve at time T
// TTL on resolution lock: 10 minutes
// Cron interval: 10 minutes

T+0:00 - Cron fires, resolution starts (will take 5 minutes)
T+0:05 - Resolution still running
T+0:10 - Cron fires again, but resolution already running → skip
T+0:15 - Resolution completes (5 minutes of work)
T+0:20 - Next cron cycle, resolution available again
```

**Test coverage**:
- ✓ Initial execution
- ✓ Overlap detection (skip logged)
- ✓ No double-processing
- ✓ Clean state after completion

## Integration with CI/CD

These tests run on every commit to `backend/`:

```yaml
# .github/workflows/backend-ci.yml
- name: Integration tests
  run: npm test -- --testPathPatterns=integration
```

## Debugging Failed Tests

### Common Issues

#### "cron.schedule was not called"
- **Cause**: Scheduler is disabled via env var
- **Fix**: Clear `AUTO_RESOLUTION_CRON_DISABLED` in beforeEach

#### "Job called twice despite overlap"
- **Cause**: Running flag not reset in finally block
- **Fix**: Check finally block in source code resets `isResolutionRunning = false`

#### "Timer doesn't advance"
- **Cause**: Missing `await` on callback invocation
- **Fix**: Use `await callback()` not just `callback()`

### Inspection Queries

```typescript
// Check what pattern was scheduled
console.log(cron.schedule.mock.calls[0][0]);

// Check how many times job was called
console.log(runAutoResolutionJob.mock.calls.length);

// Check all logged errors
console.log(logger.error.mock.calls);

// Check if scheduler was disabled
console.log(process.env.AUTO_RESOLUTION_CRON_DISABLED);
```

## Edge Cases Covered

1. **Multiple consecutive fires** — No deadlock, all execute
2. **Empty stats** — Handles 0 processed/resolved/failed
3. **Undefined return** — Job returns undefined instead of object
4. **Fast execution** — Job completes instantly
5. **Slow execution** — Job hangs, next cycle detects and skips

## Future Enhancements

### 1. Real Cron Timing (Integration)
```typescript
// Requires:
// - Real node-cron scheduler
// - Jest test with timeout >= job duration + interval
// - Actual time delays

it.skip('should fire resolution job every 10 minutes', async () => {
  jest.useRealTimers();
  
  startAutoResolutionCron();
  
  // Wait 10 minutes (600,000ms)
  await new Promise(r => setTimeout(r, 600_000));
  
  expect(runAutoResolutionJob).toHaveBeenCalled();
  expect(runAutoResolutionJob).toHaveBeenCalledTimes(
    expect.any(Number) // N times depending on duration
  );
});
```

### 2. Metrics Tracking
```typescript
// Track per-test:
// - Execution time
// - Queue wait time (if jobs queue)
// - Success rate
// - Error rate by type
```

### 3. Load Testing
```typescript
// Simulate heavy load:
// - Many markets requiring resolution
// - Concurrent API calls
// - Redis pressure
```

## References

- [node-cron Documentation](https://www.npmjs.com/package/node-cron)
- [Jest Mock Functions](https://jestjs.io/docs/mock-functions)
- [Cron Expression Format](https://crontab.guru/)
- [Implementation: src/cron/autoResolution.cron.ts](../src/cron/autoResolution.cron.ts)
