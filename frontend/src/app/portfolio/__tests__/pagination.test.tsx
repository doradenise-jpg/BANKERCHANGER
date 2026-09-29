import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PortfolioPage from '../page';

// Mock 200 total bets
const generateBets = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `bet-${i + 1}`,
    market_id: `market-${(i % 5) + 1}`,
    amount_xlm: 10,
    side: 'fighter_a',
    status: 'open',
    created_at: new Date(Date.now() - i * 1000).toISOString(),
  }));

const all200Bets = generateBets(200);

jest.mock('../../../hooks/useWallet', () => ({
  useWallet: () => ({
    address: 'GTEST_USER_ADDRESS_123',
    isConnected: true,
  }),
}));

jest.mock('../../../hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [],
  }),
}));

describe('Portfolio Page Pagination', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/bets/')) {
        const u = new URL(url, 'http://localhost');
        const cursor = Number(u.searchParams.get('cursor') || '0');
        const limit = Number(u.searchParams.get('limit') || '25');
        const pageBets = all200Bets.slice(cursor, cursor + limit);
        const nextCursor = cursor + limit < all200Bets.length ? cursor + limit : null;

        return Promise.resolve({
          ok: true,
          json: async () => ({
            bets: pageBets,
            total: 200,
            nextCursor,
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({
          total_staked_xlm: 2000,
          total_won_xlm: 0,
          total_lost_xlm: 0,
          pending_claims: [],
          active_bets: [],
          past_bets: [],
        }),
      });
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('loads first 25 bets without loading all 200, and loads more on button click', async () => {
    render(<PortfolioPage />, { wrapper });

    // Wait for initial page to render
    await waitFor(() => {
      expect(screen.getByText('Bet History')).toBeInTheDocument();
    });

    // Check first 25 bets rendered, not all 200
    await waitFor(() => {
      const loadMoreBtn = screen.getByRole('button', { name: /load more/i });
      expect(loadMoreBtn).toBeInTheDocument();
    });

    // Verify fetch was called with limit=25
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=25'));
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('cursor=0'));
  });
});
