import { generateMetadata } from '../[market_id]/page';
import * as apiService from '../../../services/api';

jest.mock('../../../services/api');

describe('Market Detail Page Metadata', () => {
  const mockFetchMarketById = apiService.fetchMarketById as jest.MockedFunction<typeof apiService.fetchMarketById>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should generate metadata with Open Graph tags for a valid market', async () => {
    const mockMarket = {
      market_id: 'test-market-123',
      match_id: 'match-456',
      fighter_a: 'Jon Doe',
      fighter_b: 'Jane Smith',
      weight_class: 'Heavyweight',
      title_fight: true,
      venue: 'Madison Square Garden',
      scheduled_at: '2024-07-15T20:00:00Z',
      status: 'open' as const,
      outcome: null,
      pool_a: '1000000',
      pool_b: '800000',
      pool_draw: '200000',
      total_pool: '2000000',
      odds_a: 5500,
      odds_b: 4000,
      odds_draw: 500,
      fee_bps: 50,
    };

    mockFetchMarketById.mockResolvedValueOnce(mockMarket);

    const metadata = await generateMetadata({ params: { market_id: 'test-market-123' } });

    expect(metadata.title).toBe('Jon Doe vs Jane Smith — BoxMeOut');
    expect(metadata.description).toContain('Jon Doe vs Jane Smith');
    expect(metadata.canonical).toContain('/markets/test-market-123');
    expect(metadata.openGraph?.title).toBe('Jon Doe vs Jane Smith — BoxMeOut');
    expect(metadata.openGraph?.description).toContain('Heavyweight');
    expect(metadata.openGraph?.type).toBe('website');
    expect(metadata.openGraph?.url).toContain('/markets/test-market-123');
    expect(metadata.openGraph?.images).toHaveLength(1);
    expect(metadata.openGraph?.images?.[0]?.width).toBe(1200);
    expect(metadata.openGraph?.images?.[0]?.height).toBe(630);
  });

  it('should include Twitter card metadata', async () => {
    const mockMarket = {
      market_id: 'test-market-456',
      match_id: 'match-789',
      fighter_a: 'Fighter A',
      fighter_b: 'Fighter B',
      weight_class: 'Middleweight',
      title_fight: false,
      venue: 'UFC Arena',
      scheduled_at: '2024-08-20T18:00:00Z',
      status: 'open' as const,
      outcome: null,
      pool_a: '500000',
      pool_b: '600000',
      pool_draw: '100000',
      total_pool: '1200000',
      odds_a: 4800,
      odds_b: 5000,
      odds_draw: 200,
      fee_bps: 50,
    };

    mockFetchMarketById.mockResolvedValueOnce(mockMarket);

    const metadata = await generateMetadata({ params: { market_id: 'test-market-456' } });

    expect(metadata.twitter?.card).toBe('summary_large_image');
    expect(metadata.twitter?.title).toBe('Fighter A vs Fighter B — BoxMeOut');
    expect(metadata.twitter?.description).toContain('Middleweight');
    expect(metadata.twitter?.images).toHaveLength(1);
  });

  it('should include Title Fight indicator in description', async () => {
    const mockMarket = {
      market_id: 'title-fight-market',
      match_id: 'match-title',
      fighter_a: 'Champion',
      fighter_b: 'Challenger',
      weight_class: 'Lightweight',
      title_fight: true,
      venue: 'Arena',
      scheduled_at: '2024-09-10T19:00:00Z',
      status: 'open' as const,
      outcome: null,
      pool_a: '2000000',
      pool_b: '1500000',
      pool_draw: '500000',
      total_pool: '4000000',
      odds_a: 6500,
      odds_b: 3200,
      odds_draw: 300,
      fee_bps: 50,
    };

    mockFetchMarketById.mockResolvedValueOnce(mockMarket);

    const metadata = await generateMetadata({ params: { market_id: 'title-fight-market' } });

    expect(metadata.description).toContain('Title Fight');
  });

  it('should return default metadata when market fetch fails', async () => {
    mockFetchMarketById.mockRejectedValueOnce(new Error('API Error'));

    const metadata = await generateMetadata({ params: { market_id: 'invalid-market' } });

    expect(metadata.title).toBe('Market');
    expect(metadata.openGraph).toBeUndefined();
  });

  it('should use correct market_id in canonical URL', async () => {
    const mockMarket = {
      market_id: 'specific-market-999',
      match_id: 'match-999',
      fighter_a: 'Boxer A',
      fighter_b: 'Boxer B',
      weight_class: 'Heavyweight',
      title_fight: false,
      venue: 'Stadium',
      scheduled_at: '2024-10-05T20:00:00Z',
      status: 'open' as const,
      outcome: null,
      pool_a: '750000',
      pool_b: '700000',
      pool_draw: '150000',
      total_pool: '1600000',
      odds_a: 5200,
      odds_b: 4700,
      odds_draw: 100,
      fee_bps: 50,
    };

    mockFetchMarketById.mockResolvedValueOnce(mockMarket);

    const metadata = await generateMetadata({ params: { market_id: 'specific-market-999' } });

    expect(metadata.canonical).toContain('/markets/specific-market-999');
    expect(metadata.openGraph?.url).toContain('/markets/specific-market-999');
  });
});
