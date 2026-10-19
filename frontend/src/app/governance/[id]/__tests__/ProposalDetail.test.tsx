process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3001';

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProposalDetail from '../page';
import * as walletService from '@/services/wallet';

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
  }),
}));

jest.mock('@/hooks/useProposalVoteUpdates', () => ({
  useProposalVoteUpdates: jest.fn(),
}));

describe('ProposalDetail Voting UI (#934)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    jest.spyOn(walletService, 'getConnectedAddress').mockReturnValue('GTEST_USER_ADDRESS_123');
    jest.spyOn(walletService, 'voteProposal').mockResolvedValue('test-vote-tx-hash-123');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('renders active proposal with voting power and enabled vote buttons', async () => {
    render(<ProposalDetail params={{ id: 'prop_1' }} />, { wrapper });

    expect(screen.getByText('Increase the fee rate to 40 bps to support the treasury.')).toBeInTheDocument();
    expect(screen.getByText(/15,000 ILN/i)).toBeInTheDocument();

    const voteForBtn = screen.getByRole('button', { name: /vote for/i });
    const voteAgainstBtn = screen.getByRole('button', { name: /vote against/i });
    const abstainBtn = screen.getByRole('button', { name: /abstain/i });

    expect(voteForBtn).toBeEnabled();
    expect(voteAgainstBtn).toBeEnabled();
    expect(abstainBtn).toBeEnabled();
  });

  it('optimistically updates vote counts, invalidates query cache, shows success banner with explorer link, and disables voting buttons', async () => {
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    render(<ProposalDetail params={{ id: 'prop_1' }} />, { wrapper });

    // Initial votesFor is 50,000
    expect(screen.getByText(/50,000/)).toBeInTheDocument();

    const voteForBtn = screen.getByRole('button', { name: /vote for/i });
    fireEvent.click(voteForBtn);

    // Wallet vote submission was called
    await waitFor(() => {
      expect(walletService.voteProposal).toHaveBeenCalledWith('prop_1', 'for');
    });

    // 1. Optimistic vote increment: 50,000 + 15,000 = 65,000
    await waitFor(() => {
      expect(screen.getByText(/65,000/)).toBeInTheDocument();
    });

    // 2. Query cache invalidation
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['proposal', 'prop_1'],
      }),
    );

    // 3. 'Vote recorded' success banner with transaction explorer link
    const banner = screen.getByTestId('vote-recorded-banner');
    expect(banner).toBeInTheDocument();
    expect(screen.getByText('Vote recorded')).toBeInTheDocument();
    const explorerLink = screen.getByRole('link', { name: /view on stellar expert/i });
    expect(explorerLink).toHaveAttribute(
      'href',
      expect.stringContaining('test-vote-tx-hash-123'),
    );

    // 4. Voting buttons disabled for address that has voted
    expect(screen.getByRole('button', { name: /vote for/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /vote against/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /abstain/i })).toBeDisabled();
  });
});
