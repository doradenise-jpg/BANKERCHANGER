import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePlaceBet } from '../usePlaceBet';
import * as walletService from '../../services/wallet';

const mockToast = {
  success: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

jest.mock('../../components/ui/ToastProvider', () => ({
  useToast: () => mockToast,
}));

jest.mock('../useWallet', () => ({
  useWallet: () => ({
    address: 'GTEST1234567890',
    isConnected: true,
  }),
}));

describe('usePlaceBet Optimistic Rollback', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    jest.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('rolls back portfolio state and shows toast on transaction failure', async () => {
    const initialPortfolio = {
      address: 'GTEST1234567890',
      total_staked_xlm: 100,
      active_bets: [],
      pending_claims: [],
      past_bets: [],
    };

    queryClient.setQueryData(['portfolio', 'GTEST1234567890'], initialPortfolio);

    // Mock failure
    jest.spyOn(walletService, 'submitBetWithStages').mockRejectedValueOnce(new Error('On-chain tx failed'));

    const { result } = renderHook(() => usePlaceBet(), { wrapper });

    await act(async () => {
      try {
        await result.current.placeBet('market-1', 'fighter_a', 50);
      } catch {
        // Expected rejection
      }
    });

    // Check portfolio state restored
    const restoredPortfolio = queryClient.getQueryData(['portfolio', 'GTEST1234567890']);
    expect(restoredPortfolio).toEqual(initialPortfolio);

    // Check toast notification
    expect(mockToast.error).toHaveBeenCalledWith('Bet failed — your balance has been restored');
  });
});
