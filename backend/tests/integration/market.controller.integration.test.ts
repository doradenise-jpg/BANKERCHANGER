import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import request from 'supertest';
import app from '../../src/index';

// Mock MarketService so tests don't need a real DB
jest.mock('../../src/services/MarketService');

import * as MarketService from '../../src/services/MarketService';

const mockMarket = {
  market_id: 'market-1',
  match_id: 'fight-1',
  status: 'open',
  weight_class: 'Heavyweight',
  fighter_a: 'Fighter A',
  fighter_b: 'Fighter B',
  scheduled_at: new Date().toISOString(),
  contract_address: 'GABC123',
};

const mockBet = {
  bet_id: 'bet-1',
  market_id: 'market-1',
  bettor_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  outcome: 'fighter_a',
  amount: '100',
};

const mockStats = {
  market_id: 'market-1',
  total_bets_count: 10,
  total_volume_xlm: 1000,
  odds_a: 6000,
  odds_b: 3000,
  odds_draw: 1000,
  top_bettors: [{ bettor_address: mockBet.bettor_address, volume_xlm: 100 }],
  betting_distribution: { A: 60, B: 30, DRAW: 10 },
};

const mockPlatformStats = {
  totalMarkets: 5,
  activeMarkets: 3,
  totalVolume: '50000',
  totalBets: 200,
};

const mockPlatformMarketStats = {
  total_markets_count: 5,
  total_volume_xlm: 5000,
  total_bets_count: 200,
  live_markets_count: 3,
  unique_bettors_count: 75,
  platform_fees_collected_xlm: 25,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/markets', () => {
  it('returns 200 with markets list', async () => {
    (MarketService.getMarkets as jest.Mock).mockResolvedValue({
      markets: [mockMarket],
      total: 1,
      hasNextPage: true,
    });

    const res = await request(app).get('/api/markets');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      markets: [mockMarket],
      total: 1,
      hasNextPage: true,
      page: 1,
      limit: 20,
    });
  });

  it('filters by status', async () => {
    (MarketService.getMarkets as jest.Mock).mockResolvedValue({ markets: [], total: 0 });

    const res = await request(app).get('/api/markets?status=open');

    expect(res.status).toBe(200);
    expect(MarketService.getMarkets).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'open' }),
      expect.anything(),
    );
  });

  it('filters by weight_class', async () => {
    (MarketService.getMarkets as jest.Mock).mockResolvedValue({ markets: [mockMarket], total: 1 });

    const res = await request(app).get('/api/markets?weight_class=Heavyweight');

    expect(res.status).toBe(200);
    expect(MarketService.getMarkets).toHaveBeenCalledWith(
      expect.objectContaining({ weight_class: 'Heavyweight' }),
      expect.anything(),
    );
  });

  it('supports pagination params', async () => {
    (MarketService.getMarkets as jest.Mock).mockResolvedValue({ markets: [], total: 0 });

    const res = await request(app).get('/api/markets?page=2&limit=10');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 2, limit: 10 });
  });

  it('returns 400 for invalid status', async () => {
    const res = await request(app).get('/api/markets?status=invalid');
    expect(res.status).toBe(422);
  });

  it('returns 400 for page < 1', async () => {
    const res = await request(app).get('/api/markets?page=0');
    expect(res.status).toBe(422);
  });

  it('accepts limit = 200 (at maximum)', async () => {
    (MarketService.getMarkets as jest.Mock).mockResolvedValue({ markets: [], total: 0 });
    const res = await request(app).get('/api/markets?limit=200');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ limit: 200 });
  });

  it('returns 400 for limit > 200', async () => {
    const res = await request(app).get('/api/markets?limit=201');
    expect(res.status).toBe(422);
  });

  it('validates dateFrom as valid date', async () => {
    (MarketService.getMarkets as jest.Mock).mockResolvedValue({ markets: [], total: 0 });
    const validDate = '2026-06-25T12:00:00Z';
    const res = await request(app).get(`/api/markets?dateFrom=${encodeURIComponent(validDate)}`);
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid dateFrom format', async () => {
    const res = await request(app).get('/api/markets?dateFrom=not-a-date');
    expect(res.status).toBe(422);
  });

  it('returns 400 for invalid dateTo format', async () => {
    const res = await request(app).get('/api/markets?dateTo=invalid-date');
    expect(res.status).toBe(422);
  });
});

describe('GET /api/recent-markets', () => {
  it('returns recent market summaries', async () => {
    const recentMarkets = [{
      fighter_a: 'Fighter A',
      fighter_b: 'Fighter B',
      status: 'open',
      total_pool_xlm: 12.5,
      created_at: '2026-11-22T12:00:00.000Z',
    }];
    (MarketService.getRecentMarkets as jest.Mock).mockResolvedValue(recentMarkets);

    const res = await request(app).get('/api/recent-markets');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(recentMarkets);
  });
});

describe('GET /api/markets/:id', () => {
  it('returns 200 with market data', async () => {
    const marketWithOdds = {
      ...mockMarket,
      odds: { odds_a: 5000, odds_b: 3000, odds_draw: 2000 },
    };
    (MarketService.getMarketById as jest.Mock).mockResolvedValue(marketWithOdds);

    const res = await request(app).get('/api/markets/1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      market_id: 'market-1',
      odds: { odds_a: 5000, odds_b: 3000, odds_draw: 2000 },
    });
    expect(MarketService.getMarketById).toHaveBeenCalledWith('market-1');
  });

  it('returns 404 when market not found', async () => {
    const { AppError } = await import('../../src/utils/AppError');
    (MarketService.getMarketById as jest.Mock).mockRejectedValue(
      AppError.notFound('Market not found'),
    );

    const res = await request(app).get('/api/markets/999');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Market not found' });
  });
});

describe('GET /api/markets/:id/bets', () => {
  it('returns all market bets when no address is provided', async () => {
    (MarketService.getBetsByMarket as jest.Mock).mockResolvedValue([mockBet]);

    const res = await request(app).get('/api/markets/market-1/bets');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([mockBet]);
    expect(MarketService.getBetsByMarket).toHaveBeenCalledWith('market-1', undefined);
  });

  it('filters bets by a valid Stellar address', async () => {
    (MarketService.getBetsByMarket as jest.Mock).mockResolvedValue([mockBet]);

    const res = await request(app).get(
      `/api/markets/market-1/bets?address=${mockBet.bettor_address}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([mockBet]);
    expect(MarketService.getBetsByMarket).toHaveBeenCalledWith(
      'market-1',
      mockBet.bettor_address,
    );
  });

  it('returns 400 for an invalid Stellar address', async () => {
    const res = await request(app).get('/api/markets/market-1/bets?address=invalid');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid Stellar address format' });
    expect(MarketService.getBetsByMarket).not.toHaveBeenCalled();
  });

  it('returns an empty array when the market has no bets', async () => {
    (MarketService.getBetsByMarket as jest.Mock).mockResolvedValue([]);

    const res = await request(app).get('/api/markets/market-1/bets');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/bets/:bettor_address', () => {
  const bettorAddress = mockBet.bettor_address;

  it('returns all bets as an array sorted newest first', async () => {
    const olderBet = { ...mockBet, bet_id: 'older', placed_at: '2025-01-01T00:00:00.000Z' };
    const newerBet = { ...mockBet, bet_id: 'newer', placed_at: '2026-01-01T00:00:00.000Z' };
    (MarketService.getBetsByAddress as jest.Mock).mockResolvedValue([olderBet, newerBet]);

    const res = await request(app).get(`/api/bets/${bettorAddress}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([newerBet, olderBet]);
    expect(MarketService.getBetsByAddress).toHaveBeenCalledWith(bettorAddress);
  });

  it('returns 400 for an invalid Stellar address', async () => {
    const res = await request(app).get('/api/bets/invalid-address');

    expect(res.status).toBe(400);
    expect(MarketService.getBetsByAddress).not.toHaveBeenCalled();
  });

  it('returns an empty array when the address has no bets', async () => {
    (MarketService.getBetsByAddress as jest.Mock).mockResolvedValue([]);

    const res = await request(app).get(`/api/bets/${bettorAddress}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/markets/:id/odds', () => {
  it('returns calculated odds for each outcome', async () => {
    const odds = {
      market_id: '1',
      fighter_a: { outcome: 'fighter_a', multiplier: 1.96, implied_probability: 50, pool: '5000', total_pool: '10000' },
      fighter_b: { outcome: 'fighter_b', multiplier: 0, implied_probability: 0, pool: '0', total_pool: '10000' },
      draw: { outcome: 'draw', multiplier: 0, implied_probability: 0, pool: '0', total_pool: '10000' },
      total_pool: '10000',
    };
    (MarketService.calculateOutcomeOdds as jest.Mock).mockResolvedValue(odds);

    const res = await request(app).get('/api/markets/1/odds');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(odds);
  });

  it('returns 404 when odds are requested for an unknown market', async () => {
    const { AppError } = await import('../../src/utils/AppError');
    (MarketService.calculateOutcomeOdds as jest.Mock).mockRejectedValue(
      AppError.notFound('Market not found'),
    );

    const res = await request(app).get('/api/markets/999/odds');

    expect(res.status).toBe(404);
  });

  it('returns 200 with market stats (odds)', async () => {
    (MarketService.getMarketStats as jest.Mock).mockResolvedValue(mockStats);

    const res = await request(app).get('/api/markets/market-1/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockStats);
  });

  it('returns 404 when market not found', async () => {
    const { AppError } = await import('../../src/utils/AppError');
    (MarketService.getMarketStats as jest.Mock).mockRejectedValue(
      AppError.notFound('Market not found'),
    );

    const res = await request(app).get('/api/markets/nonexistent/stats');

    expect(res.status).toBe(404);
  });

  it('rejects an unsupported outcome', async () => {
    const res = await request(app).get('/api/markets/market-1/odds?outcome=winner');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid outcome/);
  });
});

describe('GET /api/markets/:id/live-odds', () => {
  it('returns live odds without allowing response caching', async () => {
    const odds = {
      odds_a: 6000,
      odds_b: 3000,
      odds_draw: 1000,
      implied_probabilities: { fighter_a: 60, fighter_b: 30, draw: 10 },
    };
    (MarketService.getLiveMarketOdds as jest.Mock).mockResolvedValue(odds);

    const res = await request(app).get('/api/markets/market-1/live-odds');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(odds);
  });
});

describe('Admin endpoints require JWT', () => {
  it('returns 401 on POST /api/admin/dispute/:id without token', async () => {
    const res = await request(app).post('/api/admin/dispute/market-1');
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST /api/admin/cancel/:id without token', async () => {
    const res = await request(app).post('/api/admin/cancel/market-1');
    expect(res.status).toBe(401);
  });

  it('returns 401 on POST /api/admin/resolve-dispute/:id without token', async () => {
    const res = await request(app).post('/api/admin/resolve-dispute/market-1');
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET /api/admin/disputes without token', async () => {
    const res = await request(app).get('/api/admin/disputes');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/stats', () => {
  it('returns 200 with platform stats', async () => {
    (MarketService.getPlatformStats as jest.Mock).mockResolvedValue(mockPlatformStats);

    const res = await request(app).get('/api/stats');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(mockPlatformStats);
  });
});

describe('GET /api/market-stats', () => {
  it('returns aggregated market statistics', async () => {
    (MarketService.getPlatformMarketStats as jest.Mock).mockResolvedValue(mockPlatformMarketStats);

    const res = await request(app).get('/api/market-stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockPlatformMarketStats);
  });

  it('returns zeroed statistics with 200 if the stats service rejects', async () => {
    (MarketService.getPlatformMarketStats as jest.Mock).mockRejectedValue(new Error('database unavailable'));

    const res = await request(app).get('/api/market-stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total_markets_count: 0,
      total_volume_xlm: 0,
      total_bets_count: 0,
      live_markets_count: 0,
      unique_bettors_count: 0,
      platform_fees_collected_xlm: 0,
    });
  });
});
