// ============================================================
// BANKERCHANGER — useClaimWinnings Hook
// ============================================================

import { useState, useCallback, useRef } from 'react';
import type { TxStatus } from '../types';
import { submitClaimWithStages } from '../services/wallet';
import { fetchBetsByMarket } from '../services/api';
import { useAppStore } from '../store';
import { queryClient } from '../providers/QueryProvider';

export interface UseClaimWinningsResult {
  claimWinnings: (marketId: string) => Promise<void>;
  txStatus: TxStatus;
  txHash: string | null;
  error: string | null;
  isSubmitting: boolean;
  /** True once the user's bet for this market has been claimed (API or local). */
  hasClaimed: boolean;
  reset: () => void;
}

const IDLE: TxStatus = { hash: null, status: 'idle', error: null };

/**
 * @param walletAddress — the connected wallet address. Required for the
 *   pre-submit `claimed` re-check (issue #720, AC #2). Pass `undefined` to
 *   skip the check (the ref lock still guards double-clicks).
 */
export function useClaimWinnings(
  walletAddress?: string | null,
): UseClaimWinningsResult {
  const [txStatus, setTxStatus] = useState<TxStatus>(IDLE);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasClaimed, setHasClaimed] = useState(false);
  const { setTxStatus: setStoreTxStatus } = useAppStore();

  // AC #1 — synchronous lock. `isSubmitting` state alone is racy: two clicks
  // fired from the same render both read the stale `false` value.
  const submittingRef = useRef(false);
  // Stays true after a successful claim so a dismissed success toast cannot
  // re-enable the button on a later render.
  const claimedRef = useRef(false);

  const claimWinnings = useCallback(
    async (marketId: string) => {
      // AC #1: optimistic lock.
      if (submittingRef.current || claimedRef.current) return;
      submittingRef.current = true;

      setIsSubmitting(true);
      setError(null);
      setTxHash(null);

      const update = (status: TxStatus) => {
        setTxStatus(status);
        setStoreTxStatus(status);
      };

      try {
        // AC #2: re-check claimed state from the API before signing.
        // Non-fatal on failure — the ref lock still prevents double-submits.
        if (walletAddress) {
          try {
            const bets = await fetchBetsByMarket(marketId);
            const mine = bets.find(
              (b) => (b as any).address === walletAddress,
            );
            const already =
              mine != null &&
              ((mine as any).claimed === true ||
                (mine as any).claimed_at != null);

            if (already) {
              claimedRef.current = true;
              setHasClaimed(true);
              update(IDLE);
              return;
            }
          } catch {
            // Fall through; wallet submission will surface any real error.
          }
        }

        update({ hash: null, status: 'signing', error: null });

        const hash = await submitClaimWithStages(marketId, (stage) => {
          update({ hash: null, status: stage, error: null });
        });

        setTxHash(hash);
        claimedRef.current = true;
        setHasClaimed(true);
        update({ hash, status: 'success', error: null });

        // Invalidate caches so data refetches fresh from the server.
        await queryClient.invalidateQueries({ queryKey: ['portfolio'] });
        await queryClient.invalidateQueries({ queryKey: ['market', marketId] });
        await queryClient.invalidateQueries({ queryKey: ['bets', marketId] });

        // Legacy event for hooks using custom state management.
        window.dispatchEvent(
          new CustomEvent('bankerchanger:claim_success', {
            detail: { marketId },
          }),
        );
      } catch (e: any) {
        const msg = e?.message ?? 'Claim failed';
        setError(msg);
        update({ hash: null, status: 'error', error: msg });
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [walletAddress, setStoreTxStatus],
  );

  const reset = useCallback(() => {
    setTxStatus(IDLE);
    setStoreTxStatus(IDLE);
    setTxHash(null);
    setError(null);
    setIsSubmitting(false);
    submittingRef.current = false;
    // NOTE: claimedRef and hasClaimed are intentionally NOT reset — a
    // completed claim must stay locked. Clearing them would re-enable the
    // button after a dismissed success toast.
  }, [setStoreTxStatus]);

  return {
    claimWinnings,
    txStatus,
    txHash,
    error,
    isSubmitting,
    hasClaimed,
    reset,
  };
}