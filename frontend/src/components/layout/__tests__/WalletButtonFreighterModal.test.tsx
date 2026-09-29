import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { WalletButton } from '../WalletButton';

const mockConnect = jest.fn();
const mockConnectByType = jest.fn();

jest.mock('../../../hooks/useWallet', () => ({
  useWallet: () => ({
    address: null,
    balance: null,
    isConnected: false,
    isConnecting: false,
    connect: mockConnect,
    connectByType: mockConnectByType,
    disconnect: jest.fn(),
    availableWallets: {
      freighter: false, // Freighter NOT installed
      albedo: false,
    },
  }),
}));

describe('WalletButton when Freighter is not installed', () => {
  it('opens modal with Install Freighter notice and Albedo fallback without crashing', async () => {
    render(<WalletButton />);

    const connectBtn = screen.getByRole('button', { name: /connect wallet/i });
    expect(connectBtn).toBeInTheDocument();

    fireEvent.click(connectBtn);

    // Verify modal appeared with install notice
    await waitFor(() => {
      expect(screen.getByText('Install Freighter to use BANKERCHANGER')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /install freighter/i })).toHaveAttribute(
        'href',
        'https://freighter.app',
      );
      expect(screen.getByRole('button', { name: /connect albedo wallet/i })).toBeInTheDocument();
    });
  });
});
