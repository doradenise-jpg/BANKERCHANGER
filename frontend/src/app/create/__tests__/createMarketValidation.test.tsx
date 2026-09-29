import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import CreateMarketPage from '../page';
import * as walletService from '@/services/wallet';

const mockCreateMarket = jest.fn();

jest.mock('@/hooks/useCreateMarket', () => ({
  useCreateMarket: () => ({
    createMarket: mockCreateMarket,
    txStatus: 'idle',
    txHash: null,
    error: null,
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
  }),
}));

describe('Create Market Form Client-Side Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_ADMIN_ADDRESSES = 'GADMIN123';
    jest.spyOn(walletService, 'getConnectedAddress').mockReturnValue('GADMIN123');
  });

  it('displays inline errors and prevents submission when fighter names are empty', async () => {
    render(<CreateMarketPage />);

    // Wait for auth check to finish
    await waitFor(() => {
      expect(screen.getByText('Create Boxing Market')).toBeInTheDocument();
    });

    const submitBtn = screen.getByRole('button', { name: /create market/i });
    fireEvent.click(submitBtn);

    // Verify inline errors appear
    await waitFor(() => {
      expect(screen.getByText(/Fighter A name is required/i)).toBeInTheDocument();
      expect(screen.getByText(/Fighter B name is required/i)).toBeInTheDocument();
      expect(screen.getByText(/Match ID is required/i)).toBeInTheDocument();
    });

    // Verify no API call or contract submission was made
    expect(mockCreateMarket).not.toHaveBeenCalled();
  });
});
