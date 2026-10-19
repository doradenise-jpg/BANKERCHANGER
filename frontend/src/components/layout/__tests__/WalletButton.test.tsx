import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { WalletButton } from '../WalletButton';

const mockDisconnect = jest.fn();

jest.mock('../../../hooks/useWallet', () => ({
  useWallet: () => ({
    address: 'GBIXBYHALLELUYAH1234567890TESTNETSTUFF',
    balance: 100.5,
    isConnected: true,
    isConnecting: false,
    connect: jest.fn(),
    connectByType: jest.fn(),
    disconnect: mockDisconnect,
    availableWallets: {
      freighter: true,
      albedo: true,
    },
  }),
}));

describe('WalletButton Connected State (#922)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockImplementation(() => Promise.resolve()),
      },
    });
  });

  it('renders truncated address, balance, and menu actions', async () => {
    render(<WalletButton />);

    const button = screen.getByRole('button', { name: /wallet menu/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.getByText(/100.50 XLM/i)).toBeInTheDocument();

    // Open menu
    fireEvent.click(button);

    // Verify Copy Address, View on Explorer, Disconnect
    const copyBtn = screen.getByRole('menuitem', { name: /copy address/i });
    const explorerLink = screen.getByRole('menuitem', { name: /view on explorer/i });
    const disconnectBtn = screen.getByRole('menuitem', { name: /disconnect/i });

    expect(copyBtn).toBeInTheDocument();
    expect(explorerLink).toBeInTheDocument();
    expect(disconnectBtn).toBeInTheDocument();

    // Test copy
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'GBIXBYHALLELUYAH1234567890TESTNETSTUFF'
    );

    // Test disconnect
    fireEvent.click(disconnectBtn);
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
