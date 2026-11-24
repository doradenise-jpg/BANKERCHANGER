'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Bet, Market } from '../../types';
import { useClaimWinnings } from '../../hooks/useClaimWinnings';
import { useWallet } from '../../hooks/useWallet';
import { ConnectPrompt } from '../ui/ConnectPrompt';
import { TxStatusToast } from '../ui/TxStatusToast';
import { useAppStore } from '../../store';
import { fetchBetsByMarket, fetchMarketById } from '../../services/api';

interface ClaimFormProps {
  /** Market ID to fetch claimable bets from */
  marketId: string;
}

interface ClaimableBet extends Bet {
  market?: Market;
}

/**
 * ClaimForm component for claiming winning bets on a resolved market.
 * Features:
 * - Fetches and lists all claimable (pending, winning) bets
 * - Checkboxes to select bets to claim
 * - Computes total payout from selected bets
 * - Submit button calls claimWinnings API
 * - Shows success confirmation with transaction hash
 * - Displays "Connect Wallet" prompt if not connected
 */
export function ClaimForm({ marketId }: ClaimFormProps): JSX.Element {
  const { isConnected, address } = useWallet();
  const { claimWinnings, txStatus, txHash } = useClaimWinnings(address);
  const setTxStatus = useAppStore((s) => s.setTxStatus);

  const [claimableBets, setClaimableBets] = useState<ClaimableBet[]>([]);
  const [selectedBetIds, setSelectedBetIds] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);

  // Fetch bets for the market
  useEffect(() => {
    const loadBets = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [bets, market] = await Promise.all([
          fetchBetsByMarket(marketId),
          fetchMarketById(marketId),
        ]);

        // Filter for:
        // 1. Bets by the connected wallet
        // 2. Winning bets (resolved outcome matches bet side)
        // 3. Not yet claimed
        const claimable = bets.filter((bet) => {
          if (bet.bettor_address !== address) return false;
          if (bet.claimed || bet.claimed_at) return false;
          if (market.status !== 'resolved') return false;
          if (!market.outcome) return false;
          // Only include if outcome matches the bet side
          if (market.outcome !== bet.side) return false;
          return true;
        });

        setClaimableBets(
          claimable.map((bet) => ({
            ...bet,
            market,
          })),
        );

        if (claimable.length === 0) {
          setError('No claimable bets found for this market.');
        }
      } catch (e) {
        setError((e as Error).message || 'Failed to load bets');
      } finally {
        setIsLoading(false);
      }
    };

    if (isConnected && address && marketId) {
      loadBets();
    }
  }, [isConnected, address, marketId]);

  // Track selection state
  const handleSelectBet = useCallback((betId: number, checked: boolean) => {
    setSelectedBetIds((prev) => {
      const updated = new Set(prev);
      if (checked) {
        updated.add(betId);
      } else {
        updated.delete(betId);
      }
      return updated;
    });
  }, []);

  const handleSelectAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedBetIds(new Set(claimableBets.map((b) => b.id)));
      } else {
        setSelectedBetIds(new Set());
      }
    },
    [claimableBets],
  );

  // Compute total payout
  const totalPayout = useMemo(() => {
    return claimableBets
      .filter((bet) => selectedBetIds.has(bet.id))
      .reduce((sum, bet) => {
        const payoutXlm = bet.payout ? parseFloat(bet.payout) / 1e7 : 0;
        return sum + payoutXlm;
      }, 0);
  }, [claimableBets, selectedBetIds]);

  const isAllSelected = claimableBets.length > 0 && selectedBetIds.size === claimableBets.length;
  const isPartiallySelected = selectedBetIds.size > 0 && selectedBetIds.size < claimableBets.length;
  const canSubmit =
    isConnected &&
    selectedBetIds.size > 0 &&
    !isSubmitting &&
    claimableBets.length > 0 &&
    txStatus.status === 'idle';

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);

    try {
      // Claim winnings for the market
      // Note: The API typically handles bulk claims per market, not per bet
      await claimWinnings(marketId);
      setShowConfirmation(true);
      // Clear selection after successful claim
      setSelectedBetIds(new Set());
    } catch (e) {
      setError((e as Error).message || 'Claim failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isConnected) {
    return <ConnectPrompt />;
  }

  if (isLoading) {
    return (
      <div className="rounded-xl bg-gray-900 p-6 text-center">
        <p className="text-gray-400 font-semibold">Loading claimable bets…</p>
      </div>
    );
  }

  if (claimableBets.length === 0) {
    return (
      <div className="rounded-xl bg-gray-900 p-6 text-center">
        <p className="text-gray-400 font-semibold">No claimable bets</p>
        <p className="text-gray-500 text-sm mt-1">
          {error || 'This market has no pending winning bets to claim.'}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-gray-900 p-6 space-y-4 text-white">
      {/* Header */}
      <div className="mb-4">
        <h3 className="text-lg font-semibold">Claim Winnings</h3>
        <p className="text-sm text-gray-400 mt-1">
          {claimableBets.length} winning {claimableBets.length === 1 ? 'bet' : 'bets'} available
        </p>
      </div>

      {/* Select All Row */}
      <div className="flex items-center gap-3 p-3 bg-gray-800 rounded-lg border border-gray-700 hover:border-gray-600 transition-colors">
        <input
          type="checkbox"
          id="select-all-bets"
          checked={isAllSelected}
          ref={(el) => {
            if (el) {
              el.indeterminate = isPartiallySelected;
            }
          }}
          onChange={(e) => handleSelectAll(e.target.checked)}
          disabled={isSubmitting}
          className="w-5 h-5 cursor-pointer accent-amber-500"
          aria-label="Select all claimable bets"
        />
        <label
          htmlFor="select-all-bets"
          className="flex-1 text-sm font-medium cursor-pointer select-none"
        >
          Select All
        </label>
      </div>

      {/* Bets List */}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {claimableBets.map((bet, idx) => (
          <div
            key={bet.id}
            className="flex items-center gap-3 p-3 bg-gray-800 rounded-lg border border-gray-700 hover:border-gray-600 transition-colors"
          >
            <input
              type="checkbox"
              id={`bet-${bet.id}`}
              checked={selectedBetIds.has(bet.id)}
              onChange={(e) => handleSelectBet(bet.id, e.target.checked)}
              disabled={isSubmitting}
              className="w-5 h-5 cursor-pointer accent-amber-500"
              aria-label={`Select bet ${idx + 1}`}
            />
            <div className="flex-1 min-w-0">
              <div className="flex justify-between items-start gap-2">
                <div>
                  <p className="text-sm font-medium">
                    {bet.side === 'fighter_a' && bet.market?.fighter_a}
                    {bet.side === 'fighter_b' && bet.market?.fighter_b}
                    {bet.side === 'draw' && 'Draw'}
                  </p>
                  <p className="text-xs text-gray-400">
                    Bet: {Number(bet.amount_xlm).toFixed(4)} XLM
                  </p>
                </div>
                <div className="text-right">
                  {(() => {
                    const payoutXlm = bet.payout ? parseFloat(bet.payout) / 1e7 : 0;
                    const amountXlm = Number(bet.amount_xlm) || 0;
                    return (
                      <>
                        <p className="text-sm font-semibold text-green-400">
                          {payoutXlm.toFixed(4)} XLM
                        </p>
                        <p className="text-xs text-gray-400">
                          {amountXlm > 0 ? (((payoutXlm - amountXlm) / amountXlm) * 100).toFixed(1) : 0}%
                          gain
                        </p>
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Total Payout */}
      <div className="bg-gray-800 rounded-lg px-4 py-3 space-y-1 text-sm border border-gray-700">
        <div className="flex justify-between text-gray-400">
          <span>Selected Bets</span>
          <span>{selectedBetIds.size}</span>
        </div>
        <div className="flex justify-between font-semibold text-lg">
          <span>Total Payout</span>
          <span className="text-green-400">{totalPayout.toFixed(4)} XLM</span>
        </div>
      </div>

      {/* Error message */}
      {error && txStatus.status === 'idle' && (
        <p role="alert" className="text-xs text-red-400 p-3 bg-red-900/20 rounded-lg">
          {error}
        </p>
      )}

      {/* Submit button */}
      <button
        type="button"
        disabled={!canSubmit}
        onClick={handleSubmit}
        aria-busy={isSubmitting}
        className="w-full min-h-[44px] rounded-lg bg-green-600 hover:bg-green-500 font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
      >
        {isSubmitting ? 'Claiming…' : `Claim ${selectedBetIds.size} ${selectedBetIds.size === 1 ? 'Bet' : 'Bets'}`}
      </button>

      {/* Success Confirmation Modal */}
      {showConfirmation && txHash && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 rounded-xl p-6 max-w-md w-full space-y-4 border border-gray-700">
            <div className="text-center">
              <div className="text-4xl mb-3 text-green-400">✓</div>
              <h2 className="text-lg font-semibold">Claim Successful!</h2>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">Total Payout</span>
                <span className="font-semibold text-green-400">{totalPayout.toFixed(4)} XLM</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Transaction Hash</span>
                <span className="font-mono text-xs text-amber-400 break-all">{txHash.slice(0, 16)}…</span>
              </div>
            </div>

            <a
              href={`https://stellar.expert/explorer/public/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
            >
              View on Stellar Expert
            </a>

            <button
              type="button"
              onClick={() => {
                setShowConfirmation(false);
                setTxStatus({ hash: null, status: 'idle', error: null });
              }}
              className="w-full px-4 py-2 bg-gray-800 hover:bg-gray-700 font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Transaction status toast */}
      <TxStatusToast
        txStatus={txStatus}
        onDismiss={() => {
          setTxStatus({ hash: null, status: 'idle', error: null });
        }}
      />
    </div>
  );
}
