import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  bulkCancelMarkets,
  bulkPauseMarkets,
  calculateOdds,
  calculateOutcomeOdds,
  calculateSingleOutcomeOdds,
  defaultDbAdapter,
  getBettorStats,
  getLiveMarketOdds,
  getMarkets,
  getPlatformMarketStats,
  getPlatformStats,
  getRecentMarkets,
  invalidateMarketCache,
  setDbAdapter,
  updateMarketStatus,
  validateStatusTransition,
  type DbAdapter,
} from '../../src/services/MarketService';
import type { Market } from '../../src/models/Market';
import { pool } from '../../src/config/db';
import * as cache from '../../src/services/cache.service';
import * as StellarService from '../../src/services/StellarService';

jest.mock('../../src/services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  delPattern: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/config/db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../src/services/StellarService', () => ({
  readContractState: jest.fn(),
}));

function market(overrides: Partial<Market> = {}): Market {
  const now = new Date();
  return {
    id: 1,
    market_id: 'm1',
    contract_address: 'contract',
    match_id: 'fight',
    fighter_a: 'A',
    fighter_b: 'B',
    weight_class: 'heavyweight',
    title_fight: false,
    venue: 'venue',
    scheduled_at: now,
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
    created_at: now,
    updated_at: now,
    ledger_sequence: 1,
    ...overrides,
  };
}

function adapter(overrides: Partial<DbAdapter> = {}): DbAdapter {
  return {
    findMarkets: jest.fn().mockResolvedValue([]),
    findMarketById: jest.fn().mockResolvedValue(null),
    findBetsByAddress: jest.fn().mockResolvedValue([]),
    findBetsByMarket: jest.fn().mockResolvedValue([]),
    updateMarketStatus: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('MarketService edge cases and DB-backed paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setDbAdapter(null as never);
    (cache.get as jest.Mock).mockResolvedValue(null);
  });

  afterEach(() => {
    setDbAdapter(null as never);
  });

  it('rejects unknown and disallowed status transitions, and accepts valid ones', () => {
    expect(() => validateStatusTransition('unknown', 'open')).toThrow('Unknown market status');
    expect(() => validateStatusTransition('cancelled', 'open')).toThrow('Invalid status transition');
    expect(() => validateStatusTransition('open', 'locked')).not.toThrow();
  });

  it('does not update a missing market and invalidates caches after a valid status change', async () => {
    const missing = adapter();
    setDbAdapter(missing);
    await expect(updateMarketStatus('missing', 'locked')).rejects.toMatchObject({ statusCode: 404 });

    const found = adapter({
      findMarketById: jest.fn().mockResolvedValue(market()),
    });
    setDbAdapter(found);
    await updateMarketStatus('m1', 'locked');
    expect(found.updateMarketStatus).toHaveBeenCalledWith('m1', 'locked');
    expect(cache.delPattern).toHaveBeenCalledWith('markets:*');
  });

  it('uses cached market lists and paginates/sorts adapter results when cache misses', async () => {
    const cached = { markets: [market()], total: 1 };
    (cache.get as jest.Mock).mockResolvedValueOnce(cached);
    await expect(getMarkets()).resolves.toBe(cached);

    const markets = [
      market({ market_id: 'earlier', scheduled_at: new Date('2024-01-01'), total_pool: '10' }),
      market({ market_id: 'later', scheduled_at: new Date('2025-01-01'), total_pool: '100' }),
    ];
    setDbAdapter(adapter({ findMarkets: jest.fn().mockResolvedValue(markets) }));
    const result = await getMarkets({ sort: 'pool_desc' }, { page: 2, limit: 1 });
    expect(result.total).toBe(2);
    expect(result.markets.map((entry) => entry.market_id)).toEqual(['earlier']);
  });

  it('queries the DB adapter directly and handles optional columns in recent-market rows', async () => {
    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ fighter_a: 'A', fighter_b: 'B', status: 'open', total_pool: 'not-a-number', created_at: '2024-01-01' }],
    });
    const recent = await getRecentMarkets();
    expect(recent[0].total_pool_xlm).toBe(0);
    expect(cache.set).toHaveBeenCalledWith('markets:recent', recent, 300);
    await invalidateMarketCache('m1');
    expect(cache.del).toHaveBeenCalledWith('market:m1');
    expect(cache.del).toHaveBeenCalledWith('market:m1:stats:v2');
  });

  it('runs SQL list queries with all optional filters and maps empty DB results', async () => {
    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });
    const result = await getMarkets({
      status: 'open',
      weight_class: 'heavyweight',
      fighter: 'Ali',
      dateFrom: new Date('2024-01-01'),
      dateTo: new Date('2025-01-01'),
      sort: 'date_asc',
    }, { page: 1, limit: 5 });
    expect(result).toEqual({ markets: [], total: 0 });
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect((pool.query as jest.Mock).mock.calls[0][1]).toHaveLength(7);
  });

  it('falls back to on-chain pools for stale markets and normalizes zero odds safely', async () => {
    setDbAdapter(adapter({
      findMarketById: jest.fn().mockResolvedValue(market({
        updated_at: new Date(Date.now() - 60_000),
      })),
    }));
    (StellarService.readContractState as jest.Mock).mockResolvedValue({
      pool_a: '0',
      pool_b: '0',
      pool_draw: '0',
      total_pool: '0',
    });
    await expect(getLiveMarketOdds('m1')).resolves.toMatchObject({
      odds_a: 3334,
      odds_b: 3333,
      odds_draw: 3333,
      implied_probabilities: { fighter_a: 33.34, fighter_b: 33.33, draw: 33.33 },
    });
    expect(StellarService.readContractState).toHaveBeenCalledWith('contract', 'get_pools', []);
  });

  it('calculates empty and partially empty outcome pools without division by zero', async () => {
    setDbAdapter(adapter({
      findMarketById: jest.fn().mockResolvedValue(market({
        pool_a: '100',
        pool_b: '0',
        pool_draw: '0',
        total_pool: '100',
      })),
    }));
    await expect(calculateOdds('m1')).resolves.toEqual({ fighterA: 1, fighterB: 0, draw: 0 });
    await expect(calculateSingleOutcomeOdds('m1', 'fighter_b')).resolves.toMatchObject({
      multiplier: 0,
      implied_probability: 0,
    });
    await expect(calculateOutcomeOdds('m1')).resolves.toMatchObject({
      fighter_a: { multiplier: 0.98, implied_probability: 100 },
      fighter_b: { multiplier: 0, implied_probability: 0 },
      draw: { multiplier: 0, implied_probability: 0 },
    });
  });

  it('computes bettor stats for no bets, ties, and claimed payouts', async () => {
    const findBetsByAddress = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { side: 'fighter_a', amount: '10000000', claimed: true, payout: '12000000' },
        { side: 'fighter_b', amount: '10000000', claimed: false, payout: null },
      ]);
    setDbAdapter(adapter({ findBetsByAddress }));
    await expect(getBettorStats('empty')).resolves.toMatchObject({
      total_bets: 0,
      win_rate: 0,
      favorite_fighter: null,
    });
    await expect(getBettorStats('bettor')).resolves.toMatchObject({
      total_bets: 2,
      total_winnings_xlm: 1.2,
      win_rate: 50,
      favorite_fighter: 'fighter_a',
    });
  });

  it('computes platform stats from an adapter and SQL, and returns zeroed market stats on query failure', async () => {
    const open = market({ total_pool: '10000000' });
    const closed = market({ market_id: 'm2', status: 'resolved', total_pool: '20000000' });
    setDbAdapter(adapter({
      findMarkets: jest.fn().mockResolvedValue([open, closed]),
      findBetsByMarket: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
    }));
    await expect(getPlatformStats()).resolves.toEqual({
      totalMarkets: 2,
      activeMarkets: 1,
      totalVolume: 3,
      totalBets: 4,
    });

    setDbAdapter(null as never);
    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ total: '3', active: '1', volume: '30000000' }] })
      .mockResolvedValueOnce({ rows: [{ total: '4' }] });
    await expect(getPlatformStats()).resolves.toMatchObject({
      totalMarkets: 3,
      activeMarkets: 1,
      totalVolume: 3,
      totalBets: 4,
    });
    (pool.query as jest.Mock).mockRejectedValueOnce(new Error('db unavailable'));
    await expect(getPlatformMarketStats()).resolves.toEqual({
      total_markets_count: 0,
      total_volume_xlm: 0,
      total_bets_count: 0,
      live_markets_count: 0,
      unique_bettors_count: 0,
      platform_fees_collected_xlm: 0,
    });
  });

  it('records independent failures during bulk pause and cancellation', async () => {
    const findMarketById = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(market({ status: 'resolved' }))
      .mockResolvedValueOnce(market());
    setDbAdapter(adapter({ findMarketById }));
    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [{ market_id: 'ok' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(bulkPauseMarkets(['missing', 'bad-state', 'ok'])).resolves.toMatchObject({
      succeeded: ['ok'],
      failed: [
        { id: 'missing', reason: 'Market not found' },
        { id: 'bad-state', reason: expect.stringContaining('Invalid status transition') },
      ],
    });

    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ market_id: 'cancel-me' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(bulkCancelMarkets(['not-cancellable', 'cancel-me'], 'reason')).resolves.toEqual({
      succeeded: ['cancel-me'],
      failed: [{ id: 'not-cancellable', reason: 'Market not found or not cancellable' }],
    });
  });

  it('uses the default DB adapter query methods when no injected adapter is present', async () => {
    (pool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(defaultDbAdapter.findMarkets({ status: 'open' })).resolves.toEqual([]);
    await expect(defaultDbAdapter.findMarketById('missing')).resolves.toBeNull();
    await expect(defaultDbAdapter.findBetsByAddress('GAAA')).resolves.toEqual([]);
    await expect(defaultDbAdapter.findBetsByMarket('m1', 'GAAA')).resolves.toEqual([]);
    await expect(defaultDbAdapter.updateMarketStatus('m1', 'locked')).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(5);
  });
});
