process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3001';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PortfolioPage from '../page';

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockSearchParams = new URLSearchParams();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  useSearchParams: () => mockSearchParams,
}));

// Mock 25 total bets (3 pages of 10)
const generateBets = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    tx_hash: `tx-${i + 1}`,
    id: `bet-${i + 1}`,
    market_id: `market-${(i % 5) + 1}`,
    amount_xlm: 10,
    side: 'fighter_a',
    status: 'open',
    placed_at: new Date(Date.now() - i * 1000).toISOString(),
    payout: null,
    claimed: false,
  }));

const mock25Bets = generateBets(25);

jest.mock('../../../hooks/useWallet', () => ({
  useWallet: () => ({
    address: 'GTEST_USER_ADDRESS_123',
    isConnected: true,
  }),
}));

jest.mock('../../../components/ui/ToastProvider', () => ({
  useToast: () => ({
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
  }),
}));

jest.mock('../../../hooks/useMarkets', () => ({
  useMarkets: () => ({
    markets: [],
  }),
}));

describe('Portfolio Page Pagination (#933)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
    mockSearchParams = new URLSearchParams();

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (url.includes('/api/bets/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            bets: mock25Bets,
            total: 25,
            nextCursor: null,
          }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({
          total_staked_xlm: 250,
          total_won_xlm: 0,
          total_lost_xlm: 0,
          pending_claims: [],
          active_bets: mock25Bets,
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

  it('renders initial page with pagination controls, previous button disabled and next button enabled', async () => {
    render(<PortfolioPage />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText('Bet History')).toBeInTheDocument();
    });

    const prevBtn = screen.getByRole('button', { name: /previous page/i });
    const nextBtn = screen.getByRole('button', { name: /next page/i });

    expect(prevBtn).toBeDisabled();
    expect(nextBtn).toBeEnabled();

    fireEvent.click(nextBtn);
    expect(mockPush).toHaveBeenCalledWith('/portfolio?page=2');
  });

  it('disables the Next pagination button when page >= totalPages', async () => {
    mockSearchParams = new URLSearchParams('page=3');
    render(<PortfolioPage />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText('Bet History')).toBeInTheDocument();
    });

    const nextBtn = screen.getByRole('button', { name: /next page/i });
    expect(nextBtn).toBeDisabled();

    const prevBtn = screen.getByRole('button', { name: /previous page/i });
    expect(prevBtn).toBeEnabled();
  });

  it('handles out of range page (e.g. ?page=99) by displaying empty state message, Back to first page button, and redirecting', async () => {
    mockSearchParams = new URLSearchParams('page=99');
    render(<PortfolioPage />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('out-of-range-empty-state')).toBeInTheDocument();
    });

    expect(screen.getByText(/No bets found on page 99/i)).toBeInTheDocument();
    expect(mockReplace).toHaveBeenCalledWith('/portfolio?page=1');

    const backBtn = screen.getByRole('button', { name: /back to first page/i });
    expect(backBtn).toBeInTheDocument();

    fireEvent.click(backBtn);
    expect(mockPush).toHaveBeenCalledWith('/portfolio?page=1');
  });
});
