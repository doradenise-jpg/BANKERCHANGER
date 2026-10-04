import type { Market } from '@/types';
import { fetchMarkets } from '@/services/api';
import sitemap, { revalidate } from '@/app/sitemap';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/services/api', () => ({
  fetchMarkets: jest.fn(),
}));

const mockedFetchMarkets = jest.mocked(fetchMarkets);

describe('sitemap', () => {
  beforeEach(() => {
    mockedFetchMarkets.mockReset();
  });

  it('includes open markets with absolute URLs, updated timestamps, and market priority', async () => {
    const updatedAt = '2026-09-25T12:30:00.000Z';
    mockedFetchMarkets.mockResolvedValue({
      markets: [{ id: 42, updated_at: updatedAt } as unknown as Market],
      total: 1,
      page: 1,
      limit: 1000,
    });

    const entries = await sitemap();
    const marketEntry = entries.find((entry) => entry.url.endsWith('/markets/42'));

    expect(mockedFetchMarkets).toHaveBeenCalledWith({ status: 'open' }, { limit: 1000 });
    expect(marketEntry).toEqual(expect.objectContaining({
      url: 'https://bankerchanger.io/markets/42',
      lastModified: new Date(updatedAt),
      priority: 0.8,
    }));
    expect(() => new URL(marketEntry!.url)).not.toThrow();
  });

  it('caches the server-generated sitemap for one hour', () => {
    expect(revalidate).toBe(3600);
  });
});