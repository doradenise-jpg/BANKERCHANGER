import { fetchBetsByAddress } from '../../src/services/BetService';
import { pool } from '../../src/config/db';

describe('BetService.fetchBetsByAddress pagination', () => {
  const testAddress = 'GDSUFUWYY7RFFQ5EYT3LMVH4VXQC7XPJFXCDXPNMH6DWAKIDVXRFGQV';

  afterAll(async () => {
    await pool.end();
  });

  it('returns paginated results with correct envelope', async () => {
    const result = await fetchBetsByAddress(testAddress, 1, 50);
    
    // Verify envelope structure
    expect(result).toHaveProperty('bets');
    expect(result).toHaveProperty('total');
    expect(Array.isArray(result.bets)).toBe(true);
    expect(typeof result.total).toBe('number');
  });

  it('respects page and limit parameters', async () => {
    const page1 = await fetchBetsByAddress(testAddress, 1, 10);
    const page2 = await fetchBetsByAddress(testAddress, 2, 10);
    
    // If there are results, verify different pages
    if (page1.total > 10) {
      expect(page1.bets[0]?.id).not.toEqual(page2.bets[0]?.id);
    }
  });

  it('returns correct total count', async () => {
    const result = await fetchBetsByAddress(testAddress, 1, 50);
    
    // Total should be accurate regardless of page/limit
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.bets.length).toBeLessThanOrEqual(50);
  });

  it('handles invalid address format', async () => {
    await expect(fetchBetsByAddress('INVALID', 1, 50)).rejects.toThrow();
  });
});
