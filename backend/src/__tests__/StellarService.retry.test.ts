/**
 * StellarService — retry & error-classification tests
 *
 * Covers:
 *   1. classifySubmitError correctly identifies retryable / non-retryable codes
 *   2. withRetry: mock fails 2 times then succeeds → resolves successfully
 *   3. withRetry: each retry attempt is logged with attempt number and error code
 *   4. withRetry: non-retryable error is thrown immediately (no retry)
 *   5. withRetry: exhausts all retries and re-throws when always failing
 */

// Jest automatically uses src/utils/__mocks__/logger.ts
jest.mock('../utils/logger');

import { logger } from '../utils/logger';
import {
  classifySubmitError,
  withRetry,
  RETRYABLE_ERROR_CODES,
  NON_RETRYABLE_ERROR_CODES,
} from '../services/StellarService';

// Use fake timers so backoff delays resolve instantly in tests.
beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: run withRetry and advance all pending timers concurrently
// ---------------------------------------------------------------------------
async function runWithRetryFast<T>(
  fn: () => Promise<T>,
  maxAttempts?: number,
  context?: string,
): Promise<T> {
  const promise = withRetry(fn, maxAttempts, context);
  // Drain the microtask queue + any setTimeout callbacks repeatedly until settled.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
  }
  return promise;
}

// ============================================================
// 1. classifySubmitError
// ============================================================

describe('classifySubmitError', () => {
  it('classifies tx_bad_seq (object with status) as retryable', () => {
    const result = classifySubmitError({ status: 'tx_bad_seq' });
    expect(result.retryable).toBe(true);
    expect(result.code).toBe('tx_bad_seq');
  });

  it('classifies TRY_AGAIN_LATER as retryable', () => {
    const result = classifySubmitError({ status: 'TRY_AGAIN_LATER' });
    expect(result.retryable).toBe(true);
  });

  it('classifies TIMEOUT as retryable', () => {
    const result = classifySubmitError(new Error('TIMEOUT occurred'));
    expect(result.retryable).toBe(true);
  });

  it('classifies tx_insufficient_balance as non-retryable', () => {
    const result = classifySubmitError({ status: 'tx_insufficient_balance' });
    expect(result.retryable).toBe(false);
    expect(result.code).toBe('tx_insufficient_balance');
  });

  it('classifies FAILED status as non-retryable', () => {
    const result = classifySubmitError({ status: 'FAILED' });
    expect(result.retryable).toBe(false);
  });

  it('classifies tx_bad_auth error message as non-retryable', () => {
    const result = classifySubmitError(new Error('tx_bad_auth: signature invalid'));
    expect(result.retryable).toBe(false);
  });

  it('classifies HTTP 429 embedded in error message as retryable', () => {
    const result = classifySubmitError(new Error('Request failed with status 429 Too Many Requests'));
    expect(result.retryable).toBe(true);
    expect(result.code).toBe('429');
  });

  it('classifies unknown error as non-retryable with null code', () => {
    const result = classifySubmitError(new Error('something completely unexpected'));
    expect(result.retryable).toBe(false);
    expect(result.code).toBeNull();
  });

  it('RETRYABLE_ERROR_CODES and NON_RETRYABLE_ERROR_CODES are mutually exclusive', () => {
    for (const code of RETRYABLE_ERROR_CODES) {
      expect(NON_RETRYABLE_ERROR_CODES.has(code)).toBe(false);
    }
  });
});

// ============================================================
// 2 & 3. withRetry — fails twice then succeeds
// ============================================================

describe('withRetry — fails 2 times then succeeds', () => {
  it('resolves with the successful result on the 3rd attempt', async () => {
    const TX_HASH = 'abc123txhash';
    let callCount = 0;

    const mockFn = jest.fn(async () => {
      callCount++;
      if (callCount < 3) {
        // Simulate a transient node error that the SDK surfaces as an Error
        throw new Error('tx_bad_seq: sequence number mismatch');
      }
      return { status: 'PENDING', hash: TX_HASH };
    });

    const result = await runWithRetryFast(mockFn, 3, 'test-context');

    expect(result).toEqual({ status: 'PENDING', hash: TX_HASH });
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('logs a warn for each retry attempt with attempt number and error code', async () => {
    let callCount = 0;

    const mockFn = jest.fn(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('tx_bad_seq: sequence number mismatch');
      }
      return { status: 'PENDING', hash: 'somehash' };
    });

    await runWithRetryFast(mockFn, 3, 'test-context');

    // Should have warned exactly twice (attempt 1 and attempt 2 both retried)
    expect(logger.warn).toHaveBeenCalledTimes(2);

    // First warn: attempt 1
    const firstWarnMeta = (logger.warn as jest.Mock).mock.calls[0][0];
    expect(firstWarnMeta).toMatchObject({
      attempt: 1,
      errorCode: 'tx_bad_seq',
    });
    expect((logger.warn as jest.Mock).mock.calls[0][1]).toMatch(/attempt 1\/3/);

    // Second warn: attempt 2
    const secondWarnMeta = (logger.warn as jest.Mock).mock.calls[1][0];
    expect(secondWarnMeta).toMatchObject({
      attempt: 2,
      errorCode: 'tx_bad_seq',
    });
    expect((logger.warn as jest.Mock).mock.calls[1][1]).toMatch(/attempt 2\/3/);
  });

  it('does not log an error when eventually succeeding', async () => {
    let callCount = 0;
    const mockFn = jest.fn(async () => {
      callCount++;
      if (callCount < 3) throw new Error('tx_bad_seq');
      return 'ok';
    });

    await runWithRetryFast(mockFn, 3, 'test-context');

    expect(logger.error).not.toHaveBeenCalled();
  });
});

// ============================================================
// 4. Non-retryable error fails immediately
// ============================================================

describe('withRetry — non-retryable error', () => {
  it('throws immediately without retrying', async () => {
    const mockFn = jest.fn(async () => {
      throw new Error('tx_insufficient_balance: not enough funds');
    });

    await expect(runWithRetryFast(mockFn, 3, 'test-context')).rejects.toThrow('tx_insufficient_balance');

    // Only called once — no retries
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('logs an error (not a warn) for non-retryable failures', async () => {
    const mockFn = jest.fn(async () => {
      throw new Error('tx_insufficient_balance: not enough funds');
    });

    await expect(runWithRetryFast(mockFn, 3, 'test-context')).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const errorMeta = (logger.error as jest.Mock).mock.calls[0][0];
    expect(errorMeta).toMatchObject({
      attempt: 1,
      errorCode: 'tx_insufficient_balance',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ============================================================
// 5. Exhausts all retries
// ============================================================

describe('withRetry — always fails with retryable error', () => {
  it('re-throws the last error after exhausting all attempts', async () => {
    const mockFn = jest.fn(async () => {
      throw new Error('TRY_AGAIN_LATER: node busy');
    });

    await expect(runWithRetryFast(mockFn, 3, 'test-context')).rejects.toThrow('TRY_AGAIN_LATER');

    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('logs warn for first two retries and error for the final exhausted attempt', async () => {
    const mockFn = jest.fn(async () => {
      throw new Error('TRY_AGAIN_LATER: node busy');
    });

    await expect(runWithRetryFast(mockFn, 3, 'test-context')).rejects.toThrow();

    // 2 warn calls (retry after attempt 1, retry after attempt 2)
    expect(logger.warn).toHaveBeenCalledTimes(2);
    // 1 error call (attempt 3 = max, retries exhausted)
    expect(logger.error).toHaveBeenCalledTimes(1);
    const errorMeta = (logger.error as jest.Mock).mock.calls[0][0];
    expect(errorMeta).toMatchObject({ attempt: 3 });
  });

  it('applies exponential backoff: second delay is twice the first', async () => {
    // Track setTimeout durations
    const delays: number[] = [];
    const realSetTimeout = global.setTimeout;
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (typeof delay === 'number' && delay > 0) {
          delays.push(delay);
        }
        return realSetTimeout(fn as () => void, 0, ...args);
      });

    const mockFn = jest.fn(async () => {
      throw new Error('TRY_AGAIN_LATER');
    });

    const promise = withRetry(mockFn, 3, 'test-context');
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      jest.runAllTimers();
      await Promise.resolve();
    }
    await expect(promise).rejects.toThrow();

    setTimeoutSpy.mockRestore();

    // BASE_BACKOFF_MS=200 → delays should be [200, 400]
    const backoffDelays = delays.filter(d => d >= 200);
    expect(backoffDelays).toHaveLength(2);
    expect(backoffDelays[1]).toBe(backoffDelays[0] * 2);
  });
});
