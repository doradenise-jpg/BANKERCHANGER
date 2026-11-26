import * as MarketServiceModule from '../../src/services/MarketService';
import { setDbAdapter, getMarkets, getMarketById, getMarketOdds, calculateOutcomeOdds, getPortfolioByAddress, getPortfolioRoiByAddress, getBetsByMarket, simulateProjectedPayout, updateMarketStatus } from '../../src/services/MarketService';
import { AppError } from '../../src/utils/AppError';
import type { Market } from '../../src/models/Market';
import type { Bet } from '../../src/models/Bet';
import { pool } from '../../src/config/db';
import * as cache from '../../src/services/cache.service';
import { readContractState } from '../../src/services/StellarService';

// ── Mock cache so tests never touch Redis ────────────────────────────────────
jest.mock('../../src/services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  delPattern: jest.fn().mockResolvedValue(undefined),
  cacheDelete: jest.fn().mockResolvedValue(undefined),
  cacheDeletePattern: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/config/db', () => ({ pool: { query: jest.fn() } }));

// ── Mock StellarService to avoid SDK compilation errors ──────────────────────
jest.mock('../../src/services/StellarService', () => ({
  readContractState: jest.fn(),
  submitTransaction: jest.fn(),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────
function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: 1,
    market_id: 'mkt-1',
    contract_address: 'C...',
    match_id: 'fight-1',
    fighter_a: 'Ali',
    fighter_b: 'Frazier',
    weight_class: 'heavyweight',
    title_fight: false,
    venue: 'MSG',
    scheduled_at: new Date('2026-06-01T00:00:00Z'),
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
    ledger_sequence: 1000,
    ...overrides,
  };
}

function makeBet(overrides: Partial<Bet> = {}): Bet {
  return {
    id: 1,
    market_id: 'mkt-1',
    bettor_address: 'GAAA',
    side: 'fighter_a',
    amount: '0',
    amount_xlm: 0,
    odds_snapshot: null,
    placed_at: new Date(),
    claimed: false,
    claimed_at: null,
    payout: null,
    tx_hash: 'tx-1',
    ledger_sequence: 1,
    ...overrides,
  };
}

const MARKET_OPEN = makeMarket({ market_id: 'mkt-1', status: 'open' });
const MARKET_RESOLVED = makeMarket({ market_id: 'mkt-2', status: 'resolved' });

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('MarketService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(readContractState).mockReset();
    const dbAdapter = {
      findMarkets: jest.fn().mockResolvedValue([MARKET_OPEN, MARKET_RESOLVED]),
      findMarketById: jest.fn().mockImplementation((id: string) =>
        Promise.resolve([MARKET_OPEN, MARKET_RESOLVED].find(m => m.market_id === id) ?? null),
      ),
      findBetsByAddress: jest.fn().mockResolvedValue([]),
      findBetsByMarket: jest.fn().mockResolvedValue([]),
      updateMarketStatus: jest.fn(),
    };
    setDbAdapter(dbAdapter);
  });

  afterEach(() => {
    // Reset the DB adapter so mocks don't leak between test suites
    setDbAdapter(null as any);
  });

  // 1 ─────────────────────────────────────────────────────────────────────────
  it('getMarkets() with no filters returns all markets', async () => {
    const result = await getMarkets();
    expect(result.total).toBe(2);
    expect(result.markets).toHaveLength(2);
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  it('getMarkets() with status filter returns correct subset', async () => {
    const result = await getMarkets({ status: 'open' });
    expect(result.total).toBe(1);
    expect(result.markets[0].status).toBe('open');
  });

  it('getMarkets() paginates results and reports whether another page exists', async () => {
    const markets = [
      makeMarket({ market_id: 'mkt-1', scheduled_at: new Date('2026-06-01T00:00:00Z') }),
      makeMarket({ market_id: 'mkt-2', scheduled_at: new Date('2026-07-01T00:00:00Z') }),
      makeMarket({ market_id: 'mkt-3', scheduled_at: new Date('2026-08-01T00:00:00Z') }),
    ];
    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue(markets),
      findMarketById: jest.fn(),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    const secondPage = await getMarkets({}, { page: 2, limit: 1 });
    expect(secondPage).toMatchObject({
      markets: [expect.objectContaining({ market_id: 'mkt-2' })],
      total: 3,
      hasNextPage: true,
    });

    const lastPage = await getMarkets({}, { page: 3, limit: 1 });
    expect(lastPage).toMatchObject({
      markets: [expect.objectContaining({ market_id: 'mkt-3' })],
      total: 3,
      hasNextPage: false,
    });
  });

  it('uses the requested list cache key and returns cached results without querying the adapter', async () => {
    const findMarkets = jest.fn().mockResolvedValue([MARKET_OPEN]);
    setDbAdapter({
      findMarkets,
      findMarketById: jest.fn(),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });
    const cachedResult = { markets: [MARKET_OPEN], total: 1, hasNextPage: false };
    jest.mocked(cache.get)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cachedResult);

    const firstResult = await getMarkets(
      { status: 'open', weight_class: 'heavyweight' },
      { page: 1, limit: 10 },
    );
    const cachedResultFromCall = await getMarkets(
      { status: 'open', weight_class: 'heavyweight' },
      { page: 1, limit: 10 },
    );

    expect(firstResult).toEqual({ markets: [MARKET_OPEN], total: 1, hasNextPage: false });
    expect(cachedResultFromCall).toEqual(cachedResult);
    expect(findMarkets).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenNthCalledWith(1, 'markets:open:heavyweight:1:10');
    expect(cache.set).toHaveBeenCalledWith(
      'markets:open:heavyweight:1:10',
      firstResult,
      30,
    );
  });

  it('invalidates cached market and market-list entries after a status update', async () => {
    const updateMarket = jest.fn().mockResolvedValue(undefined);
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(MARKET_OPEN),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: updateMarket,
    });

    await updateMarketStatus('mkt-1', 'locked');

    expect(updateMarket).toHaveBeenCalledWith('mkt-1', 'locked');
    expect(cache.cacheDelete).toHaveBeenCalledWith('market:mkt-1');
    expect(cache.cacheDeletePattern).toHaveBeenCalledWith('markets:*');
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  it('getMarketById() throws AppError 404 for unknown ID', async () => {
    await expect(getMarketById('unknown')).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(getMarketById('unknown')).rejects.toBeInstanceOf(AppError);
  });

  it('getMarketById() includes live odds from getMarketOdds()', async () => {
    const market = await getMarketById('mkt-1');
    expect(market.odds).toEqual({ odds_a: 3333, odds_b: 3333, odds_draw: 3333 });
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  it('getMarketOdds() returns zero odds when the total pool is empty', async () => {
    const odds = await getMarketOdds('mkt-1'); // pool totals are all '0'
    expect(odds).toEqual({ odds_a: 0, odds_b: 0, odds_draw: 0 });
  });

  it('calculateOutcomeOdds() returns zero odds when every pool is empty', async () => {
    const odds = await calculateOutcomeOdds('mkt-1');

    expect(odds.total_pool).toBe('0');
    expect(odds.fighter_a).toMatchObject({ multiplier: 0, implied_probability: 0, pool: '0' });
    expect(odds.fighter_b).toMatchObject({ multiplier: 0, implied_probability: 0, pool: '0' });
    expect(odds.draw).toMatchObject({ multiplier: 0, implied_probability: 0, pool: '0' });
  });

  it('calculateOutcomeOdds() returns 404 for an unknown market', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(null),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    await expect(calculateOutcomeOdds('unknown')).rejects.toMatchObject({ statusCode: 404 });
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  it('getMarketOdds() returns correct basis-point values', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(
        makeMarket({
          market_id: 'mkt-3',
          pool_a: '6000',
          pool_b: '3000',
          pool_draw: '1000',
          total_pool: '10000',
        }),
      ),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn().mockResolvedValue([]),
      updateMarketStatus: jest.fn(),
    });

    const odds = await getMarketOdds('mkt-3');
    expect(odds).toEqual({ odds_a: 6000, odds_b: 3000, odds_draw: 1000 });
  });

  it('getMarketStats() reports volume, live odds, top five bettors, and a normalized distribution', async () => {
    const bets = [
      makeBet({ id: 1, bettor_address: 'GX', side: 'fighter_a', amount: '20000000' }),
      makeBet({ id: 2, bettor_address: 'GX', side: 'fighter_b', amount: '10000000' }),
      makeBet({ id: 3, bettor_address: 'GY', side: 'fighter_b', amount: '50000000' }),
      makeBet({ id: 4, bettor_address: 'GZ', side: 'draw', amount: '10000000' }),
      makeBet({ id: 5, bettor_address: 'GW', side: 'fighter_a', amount: '5000000' }),
      makeBet({ id: 6, bettor_address: 'GQ', side: 'fighter_a', amount: '3000000' }),
      makeBet({ id: 7, bettor_address: 'GR', side: 'fighter_b', amount: '2000000' }),
    ];
    const findMarketById = jest.fn().mockResolvedValue(makeMarket({
      pool_a: '28000000',
      pool_b: '62000000',
      pool_draw: '10000000',
      total_pool: '100000000',
    }));
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById,
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn().mockResolvedValue(bets),
      updateMarketStatus: jest.fn(),
    });

    const stats = await getMarketStats('mkt-1');

    expect(stats).toEqual({
      market_id: 'mkt-1',
      total_bets_count: 7,
      total_volume_xlm: 10,
      odds_a: 2800,
      odds_b: 6200,
      odds_draw: 1000,
      top_bettors: [
        { bettor_address: 'GY', volume_xlm: 5 },
        { bettor_address: 'GX', volume_xlm: 3 },
        { bettor_address: 'GZ', volume_xlm: 1 },
        { bettor_address: 'GW', volume_xlm: 0.5 },
        { bettor_address: 'GQ', volume_xlm: 0.3 },
      ],
      betting_distribution: { A: 28, B: 62, DRAW: 10 },
    });
    expect(
      stats.betting_distribution.A +
        stats.betting_distribution.B +
        stats.betting_distribution.DRAW,
    ).toBe(100);
    expect(cache.set).toHaveBeenLastCalledWith('market:mkt-1:stats:v2', stats, 60);
  });

  it('getMarketStats() returns an empty leaderboard and a 100% distribution for an empty market', async () => {
    const emptyMarket = makeMarket();
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(emptyMarket),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn().mockResolvedValue([]),
      updateMarketStatus: jest.fn(),
    });

    const stats = await getMarketStats('mkt-1');

    expect(stats.total_bets_count).toBe(0);
    expect(stats.total_volume_xlm).toBe(0);
    expect(stats.top_bettors).toEqual([]);
    expect(stats.betting_distribution).toEqual({ A: 33.34, B: 33.33, DRAW: 33.33 });
    expect(
      stats.betting_distribution.A +
        stats.betting_distribution.B +
        stats.betting_distribution.DRAW,
    ).toBe(100);

  it('getMarketOdds() calculates basis points accurately for pools larger than Number safe integers', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(
        makeMarket({
          market_id: 'mkt-big',
          pool_a: '25000000000000000000',
          pool_b: '50000000000000000000',
          pool_draw: '25000000000000000000',
          total_pool: '100000000000000000000',
        }),
      ),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    await expect(getMarketOdds('mkt-big')).resolves.toEqual({
      odds_a: 2500,
      odds_b: 5000,
      odds_draw: 2500,
    });
    expect(readContractState).not.toHaveBeenCalled();
  });

  it('getMarketOdds() reads on-chain pools when the DB snapshot is older than 30 seconds', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(
        makeMarket({
          market_id: 'mkt-stale',
          contract_address: 'C_STALE',
          pool_a: '100',
          pool_b: '100',
          pool_draw: '100',
          total_pool: '300',
          updated_at: new Date(Date.now() - 31_000),
        }),
      ),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });
    jest.mocked(readContractState).mockResolvedValue({
      pool_a: '700',
      pool_b: '200',
      pool_draw: '100',
      total_pool: '1000',
    });

    await expect(getMarketOdds('mkt-stale')).resolves.toEqual({
      odds_a: 7000,
      odds_b: 2000,
      odds_draw: 1000,
    });
    expect(readContractState).toHaveBeenCalledWith('C_STALE', 'get_pools', []);
  });

  // 6 ─────────────────────────────────────────────────────────────────────────
  it('getPortfolioByAddress() returns empty portfolio for unknown address', async () => {
    const portfolio = await getPortfolioByAddress('G_UNKNOWN');
    expect(portfolio.active_bets).toHaveLength(0);
    expect(portfolio.past_bets).toHaveLength(0);
    expect(portfolio.pending_claims).toHaveLength(0);
    expect(portfolio.total_staked_xlm).toBe(0);
    expect(portfolio.net_xlm).toBe(0);
  });

  it('getPortfolioByAddress() returns resolved history, claimable wins, XLM totals, and caches for 30 seconds', async () => {
    const bets = [
      makeBet({ id: 1, market_id: 'open', amount: '20000000' }),
      makeBet({ id: 2, market_id: 'locked', amount: '30000000' }),
      makeBet({ id: 3, market_id: 'resolved-win', amount: '40000000' }),
      makeBet({ id: 4, market_id: 'resolved-win', amount: '50000000', claimed: true, payout: '80000000' }),
      makeBet({ id: 5, market_id: 'resolved-loss', amount: '60000000' }),
      makeBet({ id: 6, market_id: 'cancelled', amount: '70000000' }),
    ];
    const markets = [
      makeMarket({ market_id: 'open', status: 'open' }),
      makeMarket({ market_id: 'locked', status: 'locked' }),
      makeMarket({ market_id: 'resolved-win', status: 'resolved', outcome: 'fighter_a' }),
      makeMarket({ market_id: 'resolved-loss', status: 'resolved', outcome: 'fighter_b' }),
      makeMarket({ market_id: 'cancelled', status: 'cancelled' }),
    ];
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockImplementation((id: string) =>
        Promise.resolve(markets.find((market) => market.market_id === id) ?? null),
      ),
      findBetsByAddress: jest.fn().mockResolvedValue(bets),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    const portfolio = await getPortfolioByAddress('GAAA');

    expect(portfolio.active_bets.map((bet) => bet.id)).toEqual([1, 2]);
    expect(portfolio.past_bets.map((bet) => bet.id)).toEqual([3, 4, 5]);
    expect(portfolio.pending_claims.map((bet) => bet.id)).toEqual([3]);
    expect(portfolio.total_staked_xlm).toBe(27);
    expect(portfolio.total_won_xlm).toBe(8);
    expect(portfolio.total_lost_xlm).toBe(6);
    expect(portfolio.net_xlm).toBe(2);
    expect(cache.set).toHaveBeenCalledWith('portfolio:GAAA', portfolio, 30);
  });

  it('getPortfolioRoiByAddress() calculates ROI, resolved win rate, streak, and caches for 60 seconds', async () => {
    (pool.query as jest.Mock).mockResolvedValue({
      rows: [
        { amount: '10000000', payout: '15000000', claimed: true, side: 'fighter_a', market_status: 'resolved', outcome: 'fighter_a' },
        { amount: '10000000', payout: null, claimed: false, side: 'fighter_b', market_status: 'resolved', outcome: 'fighter_b' },
        { amount: '10000000', payout: null, claimed: false, side: 'fighter_a', market_status: 'resolved', outcome: 'fighter_b' },
        { amount: '10000000', payout: null, claimed: false, side: 'fighter_a', market_status: 'open', outcome: null },
      ],
    });

    const result = await getPortfolioRoiByAddress('GAAA');

    expect(result).toEqual({ address: 'GAAA', roi: -62.5, win_rate: 66.67, streak: 2 });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/JOIN markets m ON b\.market_id = m\.market_id[\s\S]*ORDER BY m\.resolved_at DESC/),
      ['GAAA'],
    );
    expect(cache.set).toHaveBeenCalledWith('portfolio:GAAA:roi', result, 60);
  });

  it('getPortfolioRoiByAddress() returns zero metrics when no stake or resolved bets exist', async () => {
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

    const result = await getPortfolioRoiByAddress('GAAA');

    expect(result).toEqual({ address: 'GAAA', roi: 0, win_rate: 0, streak: 0 });
  });

  it('getPortfolioRoiByAddress() reports a negative streak for consecutive losses', async () => {
    (pool.query as jest.Mock).mockResolvedValue({
      rows: [
        { amount: '10000000', payout: null, claimed: false, side: 'fighter_a', market_status: 'resolved', outcome: 'fighter_b' },
        { amount: '10000000', payout: null, claimed: false, side: 'fighter_b', market_status: 'resolved', outcome: 'fighter_a' },
        { amount: '10000000', payout: '30000000', claimed: true, side: 'draw', market_status: 'resolved', outcome: 'draw' },
      ],
    });

    const result = await getPortfolioRoiByAddress('GAAA');

    expect(result).toEqual({ address: 'GAAA', roi: 0, win_rate: 33.33, streak: -2 });
  });

  it('getPortfolioRoiByAddress() returns a cached result without querying bets', async () => {
    const cached = { address: 'GAAA', roi: 12.5, win_rate: 50, streak: -1 };
    (pool.query as jest.Mock).mockClear();
    (cache.get as jest.Mock).mockResolvedValueOnce(cached);

    await expect(getPortfolioRoiByAddress('GAAA')).resolves.toBe(cached);
    expect(pool.query).not.toHaveBeenCalled();
  });

  // 7 ─────────────────────────────────────────────────────────────────────────
  it('getBetsByMarket() returns all bets for a market when no address filter', async () => {
    const bet1 = { id: 1, market_id: 'mkt-1', bettor_address: 'GAAA', side: 'fighter_a', amount: '1000', amount_xlm: 0.0001, placed_at: new Date(), claimed: false, claimed_at: null, payout: null, tx_hash: 'tx1', ledger_sequence: 1 } as Bet;
    const bet2 = { id: 2, market_id: 'mkt-1', bettor_address: 'GBBB', side: 'fighter_b', amount: '2000', amount_xlm: 0.0002, placed_at: new Date(), claimed: false, claimed_at: null, payout: null, tx_hash: 'tx2', ledger_sequence: 2 } as Bet;
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn(),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn().mockResolvedValue([bet1, bet2]),
      updateMarketStatus: jest.fn(),
    });
    const bets = await getBetsByMarket('mkt-1');
    expect(bets).toHaveLength(2);
  });

  // 8 ─────────────────────────────────────────────────────────────────────────
  it('getBetsByMarket() returns only matching address bets when filter applied', async () => {
    const bet = { id: 1, market_id: 'mkt-1', bettor_address: 'GAAA', side: 'fighter_a', amount: '1000', amount_xlm: 0.0001, placed_at: new Date(), claimed: false, claimed_at: null, payout: null, tx_hash: 'tx1', ledger_sequence: 1 } as Bet;
    const mockFn = jest.fn().mockResolvedValue([bet]);
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn(),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: mockFn,
      updateMarketStatus: jest.fn(),
    });
    const bets = await getBetsByMarket('mkt-1', 'GAAA');
    expect(bets).toHaveLength(1);
    expect(bets[0].bettor_address).toBe('GAAA');
    expect(mockFn).toHaveBeenCalledWith('mkt-1', 'GAAA');
  });

  // 9 ─────────────────────────────────────────────────────────────────────────
  it('getBetsByMarket() returns empty array when no bets found', async () => {
    const bets = await getBetsByMarket('mkt-1');
    expect(bets).toEqual([]);
  });

  // 10 ────────────────────────────────────────────────────────────────────────
  it('getMarkets() filters by fighter name (partial match)', async () => {
    const market1 = makeMarket({ market_id: 'mkt-1', fighter_a: 'Floyd Mayweather', fighter_b: 'Manny Pacquiao' });
    const market2 = makeMarket({ market_id: 'mkt-2', fighter_a: 'Canelo Alvarez', fighter_b: 'Gennady Golovkin' });
    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue([market1, market2]),
      findMarketById: jest.fn(),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });
    const result = await getMarkets({ fighter: 'Mayweather' });
    expect(result.total).toBe(1);
    expect(result.markets[0].fighter_a).toBe('Floyd Mayweather');
  });

  // 11 ────────────────────────────────────────────────────────────────────────
  it('getMarkets() filters by fighter name (case-insensitive)', async () => {
    const market = makeMarket({ market_id: 'mkt-1', fighter_a: 'Floyd Mayweather', fighter_b: 'Manny Pacquiao' });
    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue([market]),
      findMarketById: jest.fn(),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });
    const result = await getMarkets({ fighter: 'mayweather' });
    expect(result.total).toBe(1);
  });

  // 12 ────────────────────────────────────────────────────────────────────────
  it('getMarkets() filters by date range', async () => {
    const market1 = makeMarket({ market_id: 'mkt-1', scheduled_at: new Date('2026-06-01T00:00:00Z') });
    const market2 = makeMarket({ market_id: 'mkt-2', scheduled_at: new Date('2026-07-01T00:00:00Z') });
    const market3 = makeMarket({ market_id: 'mkt-3', scheduled_at: new Date('2026-08-01T00:00:00Z') });
    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue([market1, market2, market3]),
      findMarketById: jest.fn(),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });
    const result = await getMarkets({
      dateFrom: new Date('2026-06-15T00:00:00Z'),
      dateTo: new Date('2026-07-15T00:00:00Z'),
    });
    expect(result.total).toBe(1);
    expect(result.markets[0].market_id).toBe('mkt-2');
  });

  // 13 ────────────────────────────────────────────────────────────────────────
  it('simulateProjectedPayout() returns correct payout for fighter_a', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(
        makeMarket({
          market_id: 'mkt-sim',
          pool_a: '5000',
          pool_b: '3000',
          pool_draw: '2000',
          total_pool: '10000',
          fee_bps: 200,
          status: 'open',
        }),
      ),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    // Bet 1000 stroops on fighter_a
    // payout = (1000 * (10000 - 200)) / 5000 = (1000 * 9800) / 5000 = 1960
    const result = await simulateProjectedPayout('mkt-sim', '1000', 'fighter_a');
    expect(result.amount).toBe('1960');
    expect(result.formatted_xlm).toBe(0.000196);
  });

  // 14 ────────────────────────────────────────────────────────────────────────
  it('simulateProjectedPayout() returns correct payout for fighter_b', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(
        makeMarket({
          market_id: 'mkt-sim',
          pool_a: '5000',
          pool_b: '3000',
          pool_draw: '2000',
          total_pool: '10000',
          fee_bps: 200,
          status: 'open',
        }),
      ),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    // Bet 1500 stroops on fighter_b
    // payout = (1500 * (10000 - 200)) / 3000 = (1500 * 9800) / 3000 = 4900
    const result = await simulateProjectedPayout('mkt-sim', '1500', 'fighter_b');
    expect(result.amount).toBe('4900');
    expect(result.formatted_xlm).toBe(0.00049);
  });

  // 15 ────────────────────────────────────────────────────────────────────────
  it('simulateProjectedPayout() returns 0 for empty outcome pool', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(
        makeMarket({
          market_id: 'mkt-empty',
          pool_a: '0',
          pool_b: '5000',
          pool_draw: '0',
          total_pool: '5000',
          fee_bps: 200,
          status: 'open',
        }),
      ),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    const result = await simulateProjectedPayout('mkt-empty', '1000', 'draw');
    expect(result.amount).toBe('0');
    expect(result.formatted_xlm).toBe(0);
  });

  // 16 ────────────────────────────────────────────────────────────────────────
  it('simulateProjectedPayout() returns 0 for cancelled market', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(
        makeMarket({
          market_id: 'mkt-cancelled',
          status: 'cancelled',
        }),
      ),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    const result = await simulateProjectedPayout('mkt-cancelled', '1000', 'fighter_a');
    expect(result.amount).toBe('0');
    expect(result.formatted_xlm).toBe(0);
  });

  // 17 ────────────────────────────────────────────────────────────────────────
  it('simulateProjectedPayout() throws 404 for unknown market', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(null),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    await expect(
      simulateProjectedPayout('unknown', '1000', 'fighter_a'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // 18 ────────────────────────────────────────────────────────────────────────
  it('simulateProjectedPayout() returns 0 for zero or negative amount', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(
        makeMarket({
          market_id: 'mkt-zero',
          pool_a: '5000',
          pool_b: '3000',
          pool_draw: '2000',
          total_pool: '10000',
          fee_bps: 200,
          status: 'open',
        }),
      ),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    const result = await simulateProjectedPayout('mkt-zero', '0', 'fighter_a');
    expect(result.amount).toBe('0');
    expect(result.formatted_xlm).toBe(0);
  });

  // 19 ────────────────────────────────────────────────────────────────────────
  it('simulateProjectedPayout() returns correct payout for draw outcome', async () => {
    setDbAdapter({
      findMarkets: jest.fn(),
      findMarketById: jest.fn().mockResolvedValue(
        makeMarket({
          market_id: 'mkt-draw',
          pool_a: '7000',
          pool_b: '2000',
          pool_draw: '1000',
          total_pool: '10000',
          fee_bps: 100, // 1% fee
          status: 'locked',
        }),
      ),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });

    // Bet 500 stroops on draw
    // payout = (500 * (10000 - 100)) / 1000 = (500 * 9900) / 1000 = 4950
    const result = await simulateProjectedPayout('mkt-draw', '500', 'draw');
    expect(result.amount).toBe('4950');
    expect(result.formatted_xlm).toBe(0.000495);
  });

  // 20 ────────────────────────────────────────────────────────────────────────
  it('getMarkets() sorts by scheduled_at ASC (soonest first)', async () => {
    const market1 = makeMarket({ market_id: 'mkt-1', scheduled_at: new Date('2026-06-01T00:00:00Z') });
    const market2 = makeMarket({ market_id: 'mkt-2', scheduled_at: new Date('2026-07-01T00:00:00Z') });
    setDbAdapter({
      findMarkets: jest.fn().mockResolvedValue([market1, market2]),
      findMarketById: jest.fn(),
      findBetsByAddress: jest.fn(),
      findBetsByMarket: jest.fn(),
      updateMarketStatus: jest.fn(),
    });
    const result = await getMarkets();
    expect(result.markets[0].market_id).toBe('mkt-1');
    expect(result.markets[1].market_id).toBe('mkt-2');
  });
});
