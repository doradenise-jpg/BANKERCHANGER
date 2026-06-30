// ============================================================
// BOXMEOUT — Global Zustand Store
// Holds app-wide state: wallet, network, notifications.
// Contributors: implement the store slices.
// ============================================================

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { TxStatus } from '../types';

export type Network = 'testnet' | 'mainnet';

interface AppState {
  // ── Wallet ────────────────────────────────────────────────
  walletAddress: string | null;
  walletBalance: number | null;
  isConnecting: boolean;

  // ── Network ───────────────────────────────────────────────
  network: Network;

  // ── Last transaction ──────────────────────────────────────
  lastTxStatus: TxStatus;

  // ── Actions ───────────────────────────────────────────────
  /** Set connected wallet address and balance */
  setWallet: (address: string, balance: number) => void;
  /** Clear wallet state on disconnect */
  clearWallet: () => void;
  /** Toggle between testnet and mainnet */
  setNetwork: (network: Network) => void;
  /** Update last transaction status for TxStatusToast */
  setTxStatus: (status: TxStatus) => void;
}

/**
 * Store Shape Documentation:
 * 
 * walletAddress: string | null
 *   - Connected wallet public key (G...), or null if not connected
 * 
 * walletBalance: number | null
 *   - XLM balance in stroops (1 XLM = 10_000_000 stroops), or null if not loaded
 * 
 * isConnecting: boolean
 *   - Flag indicating active wallet connection attempt
 * 
 * network: 'testnet' | 'mainnet'
 *   - Current Stellar network (default from NEXT_PUBLIC_STELLAR_NETWORK)
 * 
 * lastTxStatus: { hash, status, error }
 *   - Last transaction result for TxStatusToast notifications
 *   - status: 'idle' | 'pending' | 'success' | 'error'
 */

export const useAppStore = create<AppState>()(
  devtools(
    (set) => ({
      walletAddress: null,
      walletBalance: null,
      isConnecting: false,
      network: (process.env.NEXT_PUBLIC_STELLAR_NETWORK as Network) ?? 'testnet',
      lastTxStatus: { hash: null, status: 'idle', error: null },

      setWallet: (address, balance) => set({ walletAddress: address, walletBalance: balance }),
      clearWallet: () => set({ walletAddress: null, walletBalance: null }),
      setNetwork: (network) => set({ network }),
      setTxStatus: (status) => set({ lastTxStatus: status }),
    }),
    { name: 'BoxmeoutAppStore' },
  ),
);
