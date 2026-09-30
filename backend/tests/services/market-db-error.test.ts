/**
 * Tests for issue #653 — MarketService.getMarkets leaks internal SQL error
 *
 * Verifies that when the database throws a raw pg error (which may include SQL
 * query text, table names, etc.), the service catches it and re-throws a
 * sanitised AppError with status 500 and a generic message instead of the raw
 * SQL error details.
 */

import { pool } from '../../src/config/db';
import { getMarkets, getPlatformStats } from '../../src/services/MarketService';
import { AppError } from '../../src/utils/AppError';
import { ERROR_CODES } from '../../src/constants/errorCodes';

// ── Mock dependencies ────────────────────────────────────────────────────────

jest.mock('../../src/config/db', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../../src/services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),  // always cache miss so DB is hit
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  delPattern: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/StellarService', () => ({
  readContractState: jest.fn(),
  submitTransaction: jest.fn(),
}));

// Silence logger output during tests
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const mockedPool = pool as jest.Mocked<typeof pool>;

/** Simulates a raw pg error that includes SQL text — the kind that would leak schema info */
function makePgError(): Error {
  const err = new Error(
    'ERROR: column "nonexistent_col" does not exist\n' +
    'HINT: Perhaps you meant to reference the column "markets.market_id".\n' +
    'QUERY: SELECT * FROM markets WHERE status = $1 ORDER BY scheduled_at DESC LIMIT $2 OFFSET $3',
  );
  (err as NodeJS.ErrnoException).code = '42703'; // UNDEFINED_COLUMN
  return err;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MarketService — #653: SQL error leak prevention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getMarkets() wraps a raw DB error in AppError and returns status 500', async () => {
    mockedPool.query.mockRejectedValue(makePgError());

    await expect(getMarkets()).rejects.toBeInstanceOf(AppError);
  });

  it('getMarkets() returns status 500 on DB failure', async () => {
    mockedPool.query.mockRejectedValue(makePgError());

    await expect(getMarkets()).rejects.toMatchObject({ statusCode: 500 });
  });

  it('getMarkets() error message does not contain SQL text or table names', async () => {
    mockedPool.query.mockRejectedValue(makePgError());

    let thrownError: AppError | null = null;
    try {
      await getMarkets();
    } catch (err) {
      thrownError = err as AppError;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError!.message).not.toMatch(/SELECT/i);
    expect(thrownError!.message).not.toMatch(/markets/i);
    expect(thrownError!.message).not.toMatch(/column/i);
    expect(thrownError!.message).not.toMatch(/scheduled_at/i);
  });

  it('getMarkets() sets error code to DATABASE_ERROR', async () => {
    mockedPool.query.mockRejectedValue(makePgError());

    await expect(getMarkets()).rejects.toMatchObject({
      code: ERROR_CODES.DATABASE_ERROR,
    });
  });

  it('getMarkets() returns generic message on DB failure', async () => {
    mockedPool.query.mockRejectedValue(makePgError());

    await expect(getMarkets()).rejects.toMatchObject({
      message: 'Failed to retrieve markets',
    });
  });

  it('getPlatformStats() wraps a raw DB error in AppError with status 500', async () => {
    mockedPool.query.mockRejectedValue(makePgError());

    await expect(getPlatformStats()).rejects.toBeInstanceOf(AppError);
    await expect(getPlatformStats()).rejects.toMatchObject({ statusCode: 500 });
  });
});
