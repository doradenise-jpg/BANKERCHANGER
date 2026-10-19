import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import PayerDashboard from '../page';
import * as walletService from '@/services/wallet';

jest.mock('@/services/wallet', () => ({
  getConnectedAddress: jest.fn(),
  markPaid: jest.fn(),
}));

describe('Payer Dashboard Recipient Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (walletService.getConnectedAddress as jest.Mock).mockReturnValue(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    );
  });

  it('shows error message on blur when recipient address is empty or invalid', () => {
    render(<PayerDashboard />);

    const addressInput = screen.getByLabelText(/Recipient Stellar Address/i);

    // Empty blur
    fireEvent.blur(addressInput);
    expect(screen.getByText('Please enter a valid Stellar address starting with G')).toBeInTheDocument();

    // Invalid address blur
    fireEvent.change(addressInput, { target: { value: 'invalid-address-123' } });
    fireEvent.blur(addressInput);
    expect(screen.getByText('Please enter a valid Stellar address starting with G')).toBeInTheDocument();

    // Valid address blur
    fireEvent.change(addressInput, {
      target: { value: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    });
    fireEvent.blur(addressInput);
    expect(screen.queryByText('Please enter a valid Stellar address starting with G')).not.toBeInTheDocument();
  });

  it('disables send payment button until address and amount are valid', () => {
    render(<PayerDashboard />);

    const button = screen.getByRole('button', { name: /Send Payment/i });
    expect(button).toBeDisabled();

    const addressInput = screen.getByLabelText(/Recipient Stellar Address/i);
    const amountInput = screen.getByLabelText(/Amount \(USDC\)/i);

    fireEvent.change(addressInput, {
      target: { value: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
    });
    expect(button).toBeDisabled();

    fireEvent.change(amountInput, { target: { value: '100' } });
    expect(button).not.toBeDisabled();
  });
});
