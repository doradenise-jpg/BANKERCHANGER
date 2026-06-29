// ============================================================
// BOXMEOUT — useClaimWinnings Hook
// ============================================================

import { useState, useCallback } from 'react';
import type { TxStatus } from '../types';
import { submitClaimWithStages } from '../services/wallet';
import { useAppStore } from '../store';

export interface UseClaimWinningsResult {
  claimWinnings: (marketId: string) => Promise<void>;
  txStatus: TxStatus;
  txHash: string | null;
  error: string | null;
  isSubmitting: boolean;
  reset: () => void;
}

const IDLE: TxStatus = { hash: null, status: 'idle', error: null };

export function useClaimWinnings(): UseClaimWinningsResult {
  const [txStatus, setTxStatus] = useState<TxStatus>(IDLE);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { setTxStatus: setStoreTxStatus } = useAppStore();

  const claimWinnings = useCallback(async (marketId: string) => {
    if (isSubmitting) return; // Prevent duplicate submissions
    
    setIsSubmitting(true);
    setError(null);
    setTxHash(null);

    const update = (status: TxStatus) => {
      setTxStatus(status);
      setStoreTxStatus(status);
    };

    update({ hash: null, status: 'signing', error: null });

    try {
      const hash = await submitClaimWithStages(marketId, (stage) => {
        update({ hash: null, status: stage, error: null });
      });

      setTxHash(hash);
      update({ hash, status: 'success', error: null });

      // Invalidate caches so useBets and useMarket refetch fresh data
      // Both hooks use useEffect with no external cache — trigger by dispatching a custom event
      window.dispatchEvent(new CustomEvent('boxmeout:claim_success', { detail: { marketId } }));
    } catch (e: any) {
      const msg = e?.message ?? 'Claim failed';
      setError(msg);
      update({ hash: null, status: 'error', error: msg });
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, setStoreTxStatus]);

  const reset = useCallback(() => {
    setTxStatus(IDLE);
    setStoreTxStatus(IDLE);
    setTxHash(null);
    setError(null);
    setIsSubmitting(false);
  }, [setStoreTxStatus]);

  return { claimWinnings, txStatus, txHash, error, isSubmitting, reset };
}
