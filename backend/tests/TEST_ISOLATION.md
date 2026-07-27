# Test Isolation Best Practices

## Problem: Cross-Test Mock Contamination

When mocks are set at module scope or not properly reset between tests, one test's mock configuration can leak into other tests, causing unexpected failures in unrelated tests.

### Before (Vulnerable)
```typescript
// BAD: Mock set at module scope, never reset
jest.mock('module', () => ({ fn: jest.fn() }));

describe('Suite', () => {
  it('test 1', () => {
    // Uses default mock from module scope
  });

  it('test 2', () => {
    // Receives modified state from test 1
  });
});
```

## Solution: Scoped Mocks with beforeEach/afterEach

### After (Isolated)
```typescript
describe('Suite', () => {
  beforeEach(() => {
    // Reset and setup fresh mocks for each test
    setupDefaultMocks();
  });

  afterEach(() => {
    // Clear all mocks to prevent cross-test contamination
    jest.clearAllMocks();
  });

  it('test 1', () => {
    // Has fresh mocks
  });

  it('test 2', () => {
    // Also has fresh mocks (test 1 cleanup ran)
  });
});
```

## Applied in market.service.test.ts

### Module-Level Mocks (Static Dependencies)
These mocks don't change between tests and are appropriate at module scope:
- `cache.service` — Never actually touches Redis in tests
- `StellarService` — Avoids SDK compilation errors

### Per-Test Mocks (Dynamic Adapters)
The database adapter is reset per test:
- `beforeEach()` — Calls `setupDefaultAdapter()` to install fresh mocks
- `afterEach()` — Calls `jest.clearAllMocks()` to reset all mock state
- Individual tests can override by calling `setDbAdapter()` with custom mocks

### Benefits
✅ Each test runs in isolation with clean mocks
✅ Failed tests don't affect others
✅ Mock state is predictable and documented
✅ No need for complex mock management or reset logic per test

## Pattern for Other Test Files

Apply the same pattern to other test suites:

```typescript
describe('MyService', () => {
  beforeEach(() => {
    // Reset mocks for this test
    setupMocks();
  });

  afterEach(() => {
    // Clean up after this test
    jest.clearAllMocks();
  });

  // Tests here
});
```

## Cleanup Strategy

- **Module-level mocks**: Use `jest.mock()` for true static dependencies only
- **Per-test setup**: Use `beforeEach()` to initialize fresh state
- **Per-test cleanup**: Use `afterEach()` to clear mocks with `jest.clearAllMocks()`
- **Spy-based mocks**: Use `jest.spyOn()` within `beforeEach()` for more control

## CI Impact

Running `npm test` with this pattern ensures:
- Reliable test results (no flaky tests from mock state leaks)
- Faster debugging (failures are localized, not cascading)
- Better parallelization (tests truly independent)
