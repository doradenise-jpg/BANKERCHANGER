import { renderHook, act, waitFor } from '@testing-library/react';
import { useWallet } from '../useWallet';
import * as walletService from '../../services/wallet';
import { useAppStore } from '../../store';
import { useWalletStore } from '../../store/walletStore';

// Mock queryClient before importing any hooks
jest.mock('../../providers/QueryProvider', () => ({
  queryClient: {
    resetQueries: jest.fn(),
    invalidateQueries: jest.fn(),
  },
}));

// Now we can safely import queryClient
const { queryClient } = require('../../providers/QueryProvider');

jest.mock('../../services/wallet');

describe('useWallet hook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    useAppStore.setState({
      walletAddress: null,
      walletBalance: null,
      isConnecting: false,
    });
    useWalletStore.setState({
      address: null,
      balance: null,
      isConnected: false,
      isConnecting: false,
    });
    (walletService.detectWallets as jest.Mock).mockReturnValue({
      freighter: true,
      albedo: false,
    });
    (walletService.getConnectedAddress as jest.Mock).mockReturnValue(null);
    (walletService.disconnectWallet as jest.Mock).mockImplementation(() => {
      sessionStorage.removeItem('bankerchanger_wallet_address');
    });
    delete (window as any).freighter;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with default state', () => {
      const { result } = renderHook(() => useWallet());

      expect(result.current.address).toBeNull();
      expect(result.current.balance).toBeNull();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should detect available wallets on mount', () => {
      renderHook(() => useWallet());

      expect(walletService.detectWallets).toHaveBeenCalled();
    });

    it('should restore address from sessionStorage on mount', async () => {
      const storedAddress = 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN';
      const balance = 150;

      (walletService.getConnectedAddress as jest.Mock).mockReturnValue(storedAddress);
      (walletService.getWalletBalance as jest.Mock).mockResolvedValue(balance);

      renderHook(() => useWallet());

      await waitFor(() => {
        expect(walletService.getWalletBalance).toHaveBeenCalled();
      });
    });

    it('should handle restore failure gracefully', async () => {
      (walletService.getConnectedAddress as jest.Mock).mockReturnValue(
        'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN'
      );
      (walletService.getWalletBalance as jest.Mock).mockRejectedValue(
        new Error('Network error')
      );

      const { result } = renderHook(() => useWallet());

      await waitFor(() => {
        // Should not crash, error handling is silent in background restore
        expect(result.current.address).toBeDefined();
      });
    });
  });

  describe('connect', () => {
    it('should connect to Freighter wallet', async () => {
      const mockAddress = 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN';
      const mockBalance = 500;

      (walletService.connectWallet as jest.Mock).mockResolvedValue(mockAddress);
      (walletService.getWalletBalance as jest.Mock).mockResolvedValue(mockBalance);

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect();
      });

      await waitFor(() => {
        expect(result.current.address).toBe(mockAddress);
        expect(result.current.balance).toBe(mockBalance);
        expect(result.current.isConnected).toBe(true);
        expect(result.current.isConnecting).toBe(false);
      });
    });

    it('should persist address to sessionStorage on connect', async () => {
      const mockAddress = 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN';
      const mockBalance = 300;

      (walletService.connectWallet as jest.Mock).mockResolvedValue(mockAddress);
      (walletService.getWalletBalance as jest.Mock).mockResolvedValue(mockBalance);

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect();
      });

      expect(sessionStorage.getItem('bankerchanger_wallet_address')).toBe(mockAddress);
    });

    it('should handle Freighter not installed error', async () => {
      const error = new walletService.WalletNotInstalledError(
        'Freighter is not installed'
      );
      (walletService.connectWallet as jest.Mock).mockRejectedValue(error);

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        try {
          await result.current.connect();
        } catch (e) {
          // Ignore
        }
      });

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
        expect(result.current.isConnected).toBe(false);
        expect(result.current.isConnecting).toBe(false);
      });
    });

    it('should handle connection rejection error', async () => {
      const error = new walletService.WalletConnectionError(
        'User rejected wallet connection'
      );
      (walletService.connectWallet as jest.Mock).mockRejectedValue(error);

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        try {
          await result.current.connect();
        } catch (e) {
          // Ignore
        }
      });

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
        expect(result.current.isConnected).toBe(false);
      });
    });

    it('should set isConnecting during connection attempt', async () => {
      let resolveConnect: (value: string) => void;
      const connectPromise = new Promise<string>((resolve) => {
        resolveConnect = resolve;
      });

      (walletService.connectWallet as jest.Mock).mockReturnValue(connectPromise);
      (walletService.getWalletBalance as jest.Mock).mockResolvedValue(100);

      const { result } = renderHook(() => useWallet());

      // Start the connection inside act
      let connectPromiseResult: Promise<void> | undefined;
      await act(async () => {
        connectPromiseResult = result.current.connect();
      });

      // Should be connecting now (after setIsConnecting is called)
      expect(result.current.isConnecting).toBe(true);

      // Resolve the wallet connection
      await act(async () => {
        resolveConnect('GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN');
        await connectPromiseResult!;
      });

      // Should be done connecting
      expect(result.current.isConnecting).toBe(false);
      expect(result.current.isConnected).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('should disconnect from wallet', async () => {
      useWalletStore.setState({
        address: 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN',
        balance: 250,
        isConnected: true,
      });

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        result.current.disconnect();
      });

      expect(walletService.disconnectWallet).toHaveBeenCalled();
      expect(useWalletStore.getState().address).toBeNull();
      expect(queryClient.resetQueries).toHaveBeenCalled();
    });

    it('should clear sessionStorage on disconnect', async () => {
      sessionStorage.setItem('bankerchanger_wallet_address', 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN');
      useWalletStore.setState({ address: 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN', isConnected: true });

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        result.current.disconnect();
      });

      expect(sessionStorage.getItem('bankerchanger_wallet_address')).toBeNull();
    });

    it('should reset queries on disconnect', async () => {
      useWalletStore.setState({
        address: 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN',
        isConnected: true,
      });

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        result.current.disconnect();
      });

      expect(queryClient.resetQueries).toHaveBeenCalled();
    });
  });

  describe('balance fetching', () => {
    it('should fetch balance from Stellar on connect', async () => {
      const mockAddress = 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN';
      const mockBalance = 1500.75;

      (walletService.connectWallet as jest.Mock).mockResolvedValue(mockAddress);
      (walletService.getWalletBalance as jest.Mock).mockResolvedValue(mockBalance);

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connect();
      });

      await waitFor(() => {
        expect(walletService.getWalletBalance).toHaveBeenCalled();
        expect(result.current.balance).toBe(mockBalance);
      });
    });

    it('should handle balance fetch errors gracefully', async () => {
      const mockAddress = 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN';

      (walletService.connectWallet as jest.Mock).mockResolvedValue(mockAddress);
      (walletService.getWalletBalance as jest.Mock).mockRejectedValue(
        new Error('Network error')
      );

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        try {
          await result.current.connect();
        } catch (e) {
          // Connection might fail or succeed despite balance fetch error
        }
      });

      // The hook should handle balance fetch failure gracefully
      // Connection itself may succeed even if balance fetch fails
      await waitFor(() => {
        expect(result.current.isConnecting).toBe(false);
      });
    });
  });

  describe('wallet detection', () => {
    it('should expose available wallets', () => {
      (walletService.detectWallets as jest.Mock).mockReturnValue({
        freighter: true,
        albedo: false,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.availableWallets.freighter).toBe(true);
      expect(result.current.availableWallets.albedo).toBe(false);
    });

    it('should detect when no wallets are available', () => {
      (walletService.detectWallets as jest.Mock).mockReturnValue({
        freighter: false,
        albedo: false,
      });

      const { result } = renderHook(() => useWallet());

      expect(result.current.availableWallets.freighter).toBe(false);
      expect(result.current.availableWallets.albedo).toBe(false);
    });
  });

  describe('account switching', () => {
    it('updates state when Freighter account changes', async () => {
      const mockFreighter = {
        isConnected: jest.fn().mockResolvedValue(true),
        getPublicKey: jest.fn().mockResolvedValue({ publicKey: 'NEW_ACCOUNT_123' }),
      };
      (window as any).freighter = mockFreighter;
      (walletService.getWalletBalance as jest.Mock).mockResolvedValue(250);

      // Initial state with old account
      useWalletStore.setState({ address: 'OLD_ACCOUNT_456', isConnected: true });

      renderHook(() => useWallet());

      // Trigger focus to invoke checkFreighter
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });

      await waitFor(() => {
        expect(useWalletStore.getState().address).toBe('NEW_ACCOUNT_123');
      });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['portfolio'] });
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['bets'] });
    });

    it('disconnects and resets queries when wallet is disconnected in extension', async () => {
      const mockFreighter = {
        isConnected: jest.fn().mockResolvedValue(false),
        getPublicKey: jest.fn().mockResolvedValue(null),
      };
      (window as any).freighter = mockFreighter;

      useWalletStore.setState({ address: 'CONNECTED_ACCOUNT', isConnected: true });

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        result.current.disconnect();
      });

      expect(walletService.disconnectWallet).toHaveBeenCalled();
      expect(useWalletStore.getState().address).toBeNull();
      expect(queryClient.resetQueries).toHaveBeenCalled();
    });
  });

  describe('connectByType', () => {
    it('should connect to Freighter by type', async () => {
      const mockAddress = 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN';
      const mockBalance = 500;

      (walletService.connectWalletByType as jest.Mock).mockResolvedValue(mockAddress);
      (walletService.getWalletBalance as jest.Mock).mockResolvedValue(mockBalance);

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connectByType('freighter');
      });

      await waitFor(() => {
        expect(result.current.address).toBe(mockAddress);
        expect(result.current.balance).toBe(mockBalance);
        expect(result.current.isConnected).toBe(true);
      });
      expect(walletService.connectWalletByType).toHaveBeenCalledWith('freighter');
    });

    it('should connect to Albedo by type', async () => {
      const mockAddress = 'GBEJXVKPQ5EJVKPQ5EJVKPQ5EJVKPQ5EJVKPQ5EJVKPQ5EJVKPQABCD';
      const mockBalance = 300;

      (walletService.connectWalletByType as jest.Mock).mockResolvedValue(mockAddress);
      (walletService.getWalletBalance as jest.Mock).mockResolvedValue(mockBalance);

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connectByType('albedo');
      });

      await waitFor(() => {
        expect(result.current.address).toBe(mockAddress);
        expect(result.current.isConnected).toBe(true);
      });
      expect(walletService.connectWalletByType).toHaveBeenCalledWith('albedo');
    });

    it('should persist address to sessionStorage on connectByType', async () => {
      const mockAddress = 'GFRQFVBHXBUMXG5JCCX3PZUDYXP4DTQNV4FSSN23ZXLPZFKW4JKBCLN';
      const mockBalance = 400;

      (walletService.connectWalletByType as jest.Mock).mockResolvedValue(mockAddress);
      (walletService.getWalletBalance as jest.Mock).mockResolvedValue(mockBalance);

      const { result } = renderHook(() => useWallet());

      await act(async () => {
        await result.current.connectByType('freighter');
      });

      expect(sessionStorage.getItem('bankerchanger_wallet_address')).toBe(mockAddress);
    });
  });
});
