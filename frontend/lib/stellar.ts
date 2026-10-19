// ============================================================
// BANKERCHANGER — Consolidated Soroban Utilities (Issue #920)
// Re-exports consolidated wallet and Soroban interaction utilities
// from `src/services/wallet` to eliminate duplicate definitions.
// ============================================================

export {
  buildContractTransaction,
  submitTransaction,
  formatTokenAmount,
  truncateAddress,
  NETWORK_PASSPHRASE,
  HORIZON_URL,
  SOROBAN_RPC_URL,
} from '../src/services/wallet';
