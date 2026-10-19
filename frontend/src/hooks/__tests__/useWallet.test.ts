import { renderHook, act } from '@testing-library/react';
import { useWallet } from '../useWallet';
import * as walletService from '../../services/wallet';
import { useAppStore } from '../../store';
import { queryClient } from '../../providers/QueryProvider';

jest.mock('../../services/wallet');
jest.mock('../../providers/QueryProvider', () => ({
  queryClient: {
    resetQueries: jest.fn(),
    invalidateQueries: jest.fn(),
  },
}));

describe('useWallet hook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAppStore.setState({
      walletAddress: null,
      walletBalance: null,
      isConnecting: false,
    });
    (walletService.detectWallets as jest.Mock).mockReturnValue({
      freighter: true,
      albedo: false,
    });
    (walletService.getConnectedAddress as jest.Mock).mockReturnValue(null);
  });

  it('updates state when Freighter account changes', async () => {
    const mockFreighter = {
      isConnected: jest.fn().mockResolvedValue(true),
      getPublicKey: jest.fn().mockResolvedValue({ publicKey: 'NEW_ACCOUNT_123' }),
    };
    (window as any).freighter = mockFreighter;
    (walletService.getWalletBalance as jest.Mock).mockResolvedValue(250);

    // Initial state with old account
    useAppStore.setState({ walletAddress: 'OLD_ACCOUNT_456' });

    renderHook(() => useWallet());

    // Trigger focus to invoke checkFreighter
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(useAppStore.getState().walletAddress).toBe('NEW_ACCOUNT_123');
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['portfolio'] });
  });

  it('disconnects and resets queries when wallet is disconnected in extension', async () => {
    const mockFreighter = {
      isConnected: jest.fn().mockResolvedValue(false),
      getPublicKey: jest.fn().mockResolvedValue(null),
    };
    (window as any).freighter = mockFreighter;

    useAppStore.setState({ walletAddress: 'CONNECTED_ACCOUNT' });

    const { result } = renderHook(() => useWallet());

    await act(async () => {
      result.current.disconnect();
    });

    expect(walletService.disconnectWallet).toHaveBeenCalled();
    expect(useAppStore.getState().walletAddress).toBeNull();
    expect(queryClient.resetQueries).toHaveBeenCalled();
  });
});
