/**
 * Tests for issue #653 — MarketService.getMarkets leaks internal SQL error
 *
 * Verifies that when the database throws a raw pg error (which may include SQL
 * query text, table names, etc.), the service catches it and re-throws a
 * sanitised AppError with status 500 and a generic message instead of the raw
 * SQL error details.
 */

import { pool } from '../../src/config/db';
import { getMarkets, getPlatformMarketStats, getPlatformStats, getRecentMarkets, getLiveMarketOdds, getMarketOdds, setDbAdapter } from '../../src/services/MarketService';
import { AppError } from '../../src/utils/AppError';
import { ERROR_CODES } from '../../src/constants/errorCodes';
import * as cache from '../../src/services/cache.service';
import type { Market } from '../../src/models/Market';
import * as StellarService from '../../src/services/StellarService';

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

function makeOddsMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: 1,
    market_id: 'live-market',
    contract_address: 'C...',
    match_id: 'fight-1',
    fighter_a: 'Fighter A',
    fighter_b: 'Fighter B',
    weight_class: '',
    title_fight: false,
    venue: '',
    scheduled_at: new Date(),
    status: 'open',
    outcome: null,
    pool_a: '0',
    pool_b: '0',
    pool_draw: '0',
    total_pool: '0',
    fee_bps: 200,
    lock_before_secs: 3600,
    resolved_at: null,
    oracle_used: null,
    created_at: new Date(),
    updated_at: new Date(),
    ledger_sequence: 0,
    ...overrides,
  };
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

  it('getMarkets() uses parameterized filters, LIMIT/OFFSET, and ascending schedule order', async () => {
    mockedPool.query
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [{ total: '25' }] } as any);

    const result = await getMarkets(
      { status: 'open', weight_class: 'heavyweight' },
      { page: 2, limit: 10 },
    );

    expect(mockedPool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        'WHERE status = $1 AND weight_class = $2 ORDER BY scheduled_at ASC LIMIT $3 OFFSET $4',
      ),
      ['open', 'heavyweight', 10, 10],
    );
    expect(mockedPool.query).toHaveBeenNthCalledWith(
      2,
      'SELECT COUNT(*) AS total FROM markets WHERE status = $1 AND weight_class = $2',
      ['open', 'heavyweight'],
    );
    expect(result).toMatchObject({ markets: [], total: 25, hasNextPage: true });
  });

  it('getPlatformStats() wraps a raw DB error in AppError with status 500', async () => {
    mockedPool.query.mockRejectedValue(makePgError());

    await expect(getPlatformStats()).rejects.toBeInstanceOf(AppError);
    await expect(getPlatformStats()).rejects.toMatchObject({ statusCode: 500 });
  });

  it('getPlatformMarketStats() converts aggregate values to XLM and caches for 10 minutes', async () => {
    mockedPool.query.mockResolvedValueOnce({
      rows: [{
        total_markets_count: '5',
        total_volume_stroops: '50000000000',
        total_bets_count: '200',
        live_markets_count: '3',
        unique_bettors_count: '75',
        platform_fees_stroops: '250000000',
      }],
    } as never);

    await expect(getPlatformMarketStats()).resolves.toEqual({
      total_markets_count: 5,
      total_volume_xlm: 5000,
      total_bets_count: 200,
      live_markets_count: 3,
      unique_bettors_count: 75,
      platform_fees_collected_xlm: 25,
    });
    expect(cache.set).toHaveBeenCalledWith(
      'platform:market-stats',
      expect.objectContaining({ total_markets_count: 5 }),
      600,
    );
  });

  it('getPlatformMarketStats() returns zeroed statistics on database failure', async () => {
    mockedPool.query.mockRejectedValue(makePgError());

    await expect(getPlatformMarketStats()).resolves.toEqual({
      total_markets_count: 0,
      total_volume_xlm: 0,
      total_bets_count: 0,
      live_markets_count: 0,
      unique_bettors_count: 0,
      platform_fees_collected_xlm: 0,
    });
  });

  it('getRecentMarkets() returns recent summaries and caches them for five minutes', async () => {
    const createdAt = new Date('2026-11-22T12:00:00.000Z');
    mockedPool.query.mockResolvedValueOnce({
      rows: [{
        fighter_a: 'Fighter A',
        fighter_b: 'Fighter B',
        status: 'open',
        total_pool: '125000000',
        created_at: createdAt,
      }],
    } as never);

    await expect(getRecentMarkets()).resolves.toEqual([{
      fighter_a: 'Fighter A',
      fighter_b: 'Fighter B',
      status: 'open',
      total_pool_xlm: 12.5,
      created_at: createdAt,
    }]);
    expect(mockedPool.query).toHaveBeenCalledWith(
      expect.stringMatching(/ORDER BY created_at DESC\s+LIMIT 10/),
      undefined,
    );
    expect(cache.set).toHaveBeenCalledWith(
      'markets:recent',
      expect.arrayContaining([expect.objectContaining({ total_pool_xlm: 12.5 })]),
      300,
    );
  });

  it('getLiveMarketOdds() calculates integer basis points and normalized probabilities', async () => {
    const market = makeOddsMarket({
      pool_a: '6000',
      pool_b: '3000',
      pool_draw: '1000',
      total_pool: '10000',
    });
    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue([]),
      findMarketById: jest.fn().mockResolvedValue(market),
      findBetsByAddress: jest.fn().mockResolvedValue([]),
      findBetsByMarket: jest.fn().mockResolvedValue([]),
      updateMarketStatus: jest.fn(),
    });

    await expect(getLiveMarketOdds(market.market_id)).resolves.toEqual({
      odds_a: 6000,
      odds_b: 3000,
      odds_draw: 1000,
      implied_probabilities: {
        fighter_a: 60,
        fighter_b: 30,
        draw: 10,
      },
    });
    await expect(getMarketOdds(market.market_id)).resolves.toEqual({
      odds_a: 6000,
      odds_b: 3000,
      odds_draw: 1000,
    });
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('getLiveMarketOdds() distributes rounding remainder for empty pools', async () => {
    const market = makeOddsMarket();
    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue([]),
      findMarketById: jest.fn().mockResolvedValue(market),
      findBetsByAddress: jest.fn().mockResolvedValue([]),
      findBetsByMarket: jest.fn().mockResolvedValue([]),
      updateMarketStatus: jest.fn(),
    });

    const odds = await getLiveMarketOdds(market.market_id);

    expect([odds.odds_a, odds.odds_b, odds.odds_draw]).toEqual([3334, 3333, 3333]);
    expect(odds.odds_a + odds.odds_b + odds.odds_draw).toBe(10_000);
    expect(
      odds.implied_probabilities.fighter_a +
      odds.implied_probabilities.fighter_b +
      odds.implied_probabilities.draw,
    ).toBe(100);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('getLiveMarketOdds() refreshes stale pools from Stellar RPC', async () => {
    const market = makeOddsMarket({
      pool_a: '1',
      pool_b: '1',
      pool_draw: '1',
      total_pool: '3',
      updated_at: new Date(Date.now() - 31_000),
    });
    (StellarService.readContractState as jest.Mock).mockResolvedValue({
      pool_a: '1',
      pool_b: '2',
      pool_draw: '0',
      total_pool: '3',
    });
    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue([]),
      findMarketById: jest.fn().mockResolvedValue(market),
      findBetsByAddress: jest.fn().mockResolvedValue([]),
      findBetsByMarket: jest.fn().mockResolvedValue([]),
      updateMarketStatus: jest.fn(),
    });

    await expect(getLiveMarketOdds(market.market_id)).resolves.toEqual({
      odds_a: 3333,
      odds_b: 6667,
      odds_draw: 0,
      implied_probabilities: {
        fighter_a: 33.33,
        fighter_b: 66.67,
        draw: 0,
      },
    });
    expect(StellarService.readContractState).toHaveBeenCalledWith(
      market.contract_address,
      'get_pools',
      [],
    );
    expect(cache.get).not.toHaveBeenCalled();
  });
});
