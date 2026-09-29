// ============================================================
// BANKERCHANGER — usePlaceBet Hook
// Mutation hook for signing and broadcasting place_bet transactions
// with optimistic UI updates and error rollback
// ============================================================

import { useCallback, useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BetSide, TxStatus } from '../types';
import { submitBetWithStages } from '../services/wallet';
import { useAppStore } from '../store';
import { useToast } from '../components/ui/ToastProvider';
import { useWallet } from './useWallet';

export interface UsePlaceBetResult {
  placeBet: (market_id: string, side: BetSide, amount_xlm: number) => Promise<void>;
  txStatus: TxStatus;
  txHash: string | null;
  error: string | null;
  reset: () => void;
}

interface PlaceBetVariables {
  market_id: string;
  side: BetSide;
  amount_xlm: number;
}

interface MutationContext {
  previousPortfolio?: any;
  previousBets?: any;
  timeoutId?: NodeJS.Timeout;
}

/**
 * Mutation hook for placing a bet on a market.
 * Manages state machine: idle → signing → broadcasting → confirming → success | error
 * Optimistically updates user state, and rolls back with a toast on error.
 */
export function usePlaceBet(): UsePlaceBetResult {
  const [txStatus, setTxStatus] = useState<TxStatus>({ hash: null, status: 'idle', error: null });
  const [error, setError] = useState<string | null>(null);
  const { setTxStatus: setAppTxStatus } = useAppStore();
  const { address } = useWallet();
  const queryClient = useQueryClient();
  const toast = useToast();
  const optimisticTimerRef = useRef<NodeJS.Timeout | null>(null);

  const mutation = useMutation<string, Error, PlaceBetVariables, MutationContext>({
    mutationFn: async ({ market_id, side, amount_xlm }) => {
      return await submitBetWithStages(market_id, side, amount_xlm, (stage) => {
        if (stage === 'signing') {
          setTxStatus({ hash: null, status: 'signing', error: null });
        } else if (stage === 'broadcasting') {
          setTxStatus({ hash: null, status: 'broadcasting', error: null });
        } else if (stage === 'confirming') {
          setTxStatus({ hash: null, status: 'confirming', error: null });
        }
      });
    },
    onMutate: async ({ market_id, side, amount_xlm }) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ['portfolio', address] });
      await queryClient.cancelQueries({ queryKey: ['bets', address] });

      // Snapshot the previous value
      const previousPortfolio = queryClient.getQueryData(['portfolio', address]);
      const previousBets = queryClient.getQueryData(['bets', address]);

      // Optimistically update portfolio state
      if (previousPortfolio) {
        queryClient.setQueryData(['portfolio', address], (old: any) => {
          if (!old) return old;
          return {
            ...old,
            total_staked_xlm: (old.total_staked_xlm ?? 0) + amount_xlm,
            active_bets: [
              {
                id: `optimistic-${Date.now()}`,
                market_id,
                side,
                amount_xlm,
                status: 'pending',
                created_at: new Date().toISOString(),
              },
              ...(old.active_bets || []),
            ],
          };
        });
      }

      // Ensure no lingering optimistic state after 5 seconds regardless of outcome
      const timeoutId = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['portfolio', address] });
        queryClient.invalidateQueries({ queryKey: ['bets', address] });
      }, 5000);
      optimisticTimerRef.current = timeoutId;

      return { previousPortfolio, previousBets, timeoutId };
    },
    onError: (err, _variables, context) => {
      const msg = err?.message ?? 'Transaction failed';
      setError(msg);
      setTxStatus({ hash: null, status: 'error', error: msg });
      setAppTxStatus({ hash: null, status: 'error', error: msg });

      // Rollback to snapshot
      if (context?.previousPortfolio) {
        queryClient.setQueryData(['portfolio', address], context.previousPortfolio);
      }
      if (context?.previousBets) {
        queryClient.setQueryData(['bets', address], context.previousBets);
      }

      // Notify user of rollback
      toast.error('Bet failed — your balance has been restored');
    },
    onSuccess: (hash, { market_id }) => {
      setTxStatus({ hash, status: 'success', error: null });
      setAppTxStatus({ hash, status: 'success', error: null });

      // Invalidate relevant query caches
      queryClient.invalidateQueries({ queryKey: ['portfolio', address] });
      queryClient.invalidateQueries({ queryKey: ['bets', address] });
      queryClient.invalidateQueries({ queryKey: ['market', market_id] });
    },
    onSettled: (_data, _error, _variables, context) => {
      if (context?.timeoutId) {
        clearTimeout(context.timeoutId);
      }
      if (optimisticTimerRef.current) {
        clearTimeout(optimisticTimerRef.current);
        optimisticTimerRef.current = null;
      }
    },
  });

  const placeBet = useCallback(
    async (market_id: string, side: BetSide, amount_xlm: number) => {
      setError(null);
      setTxStatus({ hash: null, status: 'signing', error: null });
      await mutation.mutateAsync({ market_id, side, amount_xlm });
    },
    [mutation],
  );

  const reset = useCallback(() => {
    setTxStatus({ hash: null, status: 'idle', error: null });
    setError(null);
    setAppTxStatus({ hash: null, status: 'idle', error: null });
    mutation.reset();
  }, [setAppTxStatus, mutation]);

  return {
    placeBet,
    txStatus,
    txHash: txStatus.hash,
    error,
    reset,
  };
}
