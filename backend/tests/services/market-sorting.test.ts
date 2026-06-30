import { getMarkets } from '../../src/services/MarketService';
import { pool } from '../../src/config/db';

describe('MarketService.getMarkets sorting', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('sorts by scheduled_at DESC by default', async () => {
    const result = await getMarkets({}, { page: 1, limit: 50 });
    
    if (result.markets.length > 1) {
      const first = new Date(result.markets[0].scheduled_at).getTime();
      const second = new Date(result.markets[1].scheduled_at).getTime();
      expect(first).toBeGreaterThanOrEqual(second);
    }
  });

  it('sorts by scheduled_at ASC when sort=date_asc', async () => {
    const result = await getMarkets({ sort: 'date_asc' }, { page: 1, limit: 50 });
    
    if (result.markets.length > 1) {
      const first = new Date(result.markets[0].scheduled_at).getTime();
      const second = new Date(result.markets[1].scheduled_at).getTime();
      expect(first).toBeLessThanOrEqual(second);
    }
  });

  it('sorts by total_pool DESC when sort=pool_desc', async () => {
    const result = await getMarkets({ sort: 'pool_desc' }, { page: 1, limit: 50 });
    
    if (result.markets.length > 1) {
      const first = Number(result.markets[0].total_pool);
      const second = Number(result.markets[1].total_pool);
      expect(first).toBeGreaterThanOrEqual(second);
    }
  });

  it('includes sort in cache key', async () => {
    // Both calls should return different order
    const descResult = await getMarkets({ sort: 'date_desc' }, { page: 1, limit: 50 });
    const ascResult = await getMarkets({ sort: 'date_asc' }, { page: 1, limit: 50 });
    
    if (descResult.markets.length > 1 && ascResult.markets.length > 1) {
      // First market should be different when sorted differently
      expect(descResult.markets[0].market_id).not.toEqual(ascResult.markets[0].market_id);
    }
  });
});
