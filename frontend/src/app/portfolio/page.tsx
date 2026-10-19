'use client';

// ============================================================
// BANKERCHANGER — Portfolio Page (/portfolio)
// ============================================================

import { useMemo, useCallback, useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useWallet } from '../../hooks/useWallet';
import { usePortfolio } from '../../hooks/usePortfolio';
import { useMarkets } from '../../hooks/useMarkets';
import { ConnectPrompt } from '../../components/ui/ConnectPrompt';
import { BetHistoryTable } from '../../components/bet/BetHistoryTable';
import { useToast } from '../../components/ui/ToastProvider';
import type { Bet } from '../../types';

// ─── BettorStats ─────────────────────────────────────────────────────────────

interface BettorStatsProps {
  totalStaked: number;
  totalWon: number;
  totalLost: number;
  pendingClaimsCount: number;
}

function BettorStats({ totalStaked, totalWon, totalLost, pendingClaimsCount }: BettorStatsProps) {
  const winRate = totalStaked > 0 ? ((totalWon / totalStaked) * 100).toFixed(1) : '0.0';
  const stats = [
    { label: 'Total Staked', value: `${totalStaked.toFixed(2)} XLM` },
    { label: 'Total Won',    value: `${totalWon.toFixed(2)} XLM`,  color: 'text-green-400' },
    { label: 'Total Lost',   value: `${totalLost.toFixed(2)} XLM`, color: 'text-red-400' },
    { label: 'Win Rate',     value: `${winRate}%` },
    { label: 'Pending Claims', value: String(pendingClaimsCount), color: pendingClaimsCount > 0 ? 'text-amber-400' : undefined },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {stats.map(({ label, value, color }) => (
        <div key={label} className="bg-gray-900 rounded-xl p-4 text-center">
          <p className="text-xs text-gray-400">{label}</p>
          <p className={`text-base font-semibold mt-1 break-words ${color ?? 'text-white'}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

export default function PortfolioPage(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isConnected } = useWallet();
  const { markets } = useMarkets();
  const {
    portfolio,
    bets: paginatedBets,
    performance,
    isLoading,
    claimTxStatus,
    claimWinnings,
    claimRefund,
    hasNextPage,
    isFetchingNextPage,
    loadNextPage,
  } = usePortfolio(markets);
  const [claimingAll, setClaimingAll] = useState(false);
  const toast = useToast();

  const marketsMap = useMemo(
    () => Object.fromEntries(markets.map((m) => [m.market_id, m])),
    [markets],
  );

  const allBets: Bet[] = useMemo(() => {
    if (paginatedBets && paginatedBets.length > 0) {
      return paginatedBets;
    }
    if (!portfolio) return [];
    return [
      ...portfolio.pending_claims,
      ...portfolio.active_bets,
      ...portfolio.past_bets,
    ];
  }, [paginatedBets, portfolio]);

  const rawPage = searchParams.get('page');
  const parsedPage = rawPage ? parseInt(rawPage, 10) : 1;
  const currentPage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  const totalBets = allBets.length;
  const totalPages = Math.max(1, Math.ceil(totalBets / PAGE_SIZE));
  const isOutOfRange = totalBets > 0 && currentPage > totalPages;

  useEffect(() => {
    if (isOutOfRange) {
      router.replace('/portfolio?page=1');
    }
  }, [isOutOfRange, router]);

  const displayedBets = useMemo(() => {
    return allBets.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  }, [allBets, currentPage]);

  const handleClaimAll = useCallback(async () => {
    if (!portfolio || claimingAll) return;
    setClaimingAll(true);
    // Deduplicate by market_id — one tx per claimable market
    const uniqueMarkets = [...new Set(portfolio.pending_claims.map((b) => b.market_id))];
    for (const market_id of uniqueMarkets) {
      await claimWinnings(market_id);
    }
    setClaimingAll(false);
  }, [portfolio, claimWinnings, claimingAll]);

  // Toast feedback for claim/refund transactions
  useEffect(() => {
    if (claimTxStatus.status === 'success') {
      toast.success('Winnings claimed successfully!');
    } else if (claimTxStatus.status === 'error') {
      toast.error(claimTxStatus.error ?? 'Claim failed. Please try again.');
    }
  }, [claimTxStatus.status]);

  if (!isConnected) {
    return (
      <main className="max-w-2xl mx-auto mt-20 px-4">
        <ConnectPrompt message="Connect your Freighter wallet to view your portfolio" />
      </main>
    );
  }

  if (isLoading) {
    return <main className="text-center mt-20 text-gray-400">Loading portfolio…</main>;
  }

  const isEmpty = !portfolio || allBets.length === 0;

  if (isEmpty) {
    return (
      <main className="text-center mt-20 space-y-3 px-4">
        <p className="text-4xl">🥊</p>
        <p className="text-gray-400">No bets yet — find a fight to bet on</p>
        <Link href="/" className="inline-block text-amber-400 hover:text-amber-300 text-sm">
          Browse markets →
        </Link>
      </main>
    );
  }

  if (isOutOfRange) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        <div className="text-center py-16 space-y-4 bg-gray-900 rounded-xl border border-gray-800 p-8" data-testid="out-of-range-empty-state">
          <p className="text-4xl">📄</p>
          <h2 className="text-lg font-bold text-white">No bets found on page {currentPage}</h2>
          <p className="text-gray-400 text-sm">
            Requested page exceeds available pages ({totalPages}).
          </p>
          <button
            onClick={() => router.push('/portfolio?page=1')}
            className="min-h-[44px] px-5 rounded-xl bg-amber-500 hover:bg-amber-400 font-semibold text-black text-sm"
          >
            Back to first page
          </button>
        </div>
      </main>
    );
  }

  const pendingCount = portfolio!.pending_claims.length;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-xl font-bold text-white">My Portfolio</h1>
        {pendingCount > 0 && (
          <button
            onClick={handleClaimAll}
            disabled={claimingAll || claimTxStatus.status === 'pending'}
            className="min-h-[44px] px-5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-black text-sm"
          >
            {claimingAll ? 'Claiming…' : `Claim All (${pendingCount})`}
          </button>
        )}
      </div>

      <section aria-label="Open position performance" className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div>
          <p className="text-xs text-gray-400">Total Invested</p>
          <p className="mt-1 text-lg font-semibold text-white">{performance.totalInvestedXlm.toFixed(2)} XLM</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Current Value</p>
          <p className="mt-1 text-lg font-semibold text-white">{performance.currentValueXlm.toFixed(2)} XLM</p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Unrealized P&amp;L</p>
          <p className={`mt-1 text-lg font-semibold ${performance.unrealizedPnlXlm >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {performance.unrealizedPnlXlm >= 0 ? '+' : ''}{performance.unrealizedPnlXlm.toFixed(2)} XLM
            <span className="ml-2 text-sm">({performance.unrealizedPnlPercent >= 0 ? '+' : ''}{performance.unrealizedPnlPercent.toFixed(1)}%)</span>
          </p>
        </div>
      </section>

      {/* Stats */}
      <BettorStats
        totalStaked={portfolio!.total_staked_xlm ?? 0}
        totalWon={portfolio!.total_won_xlm ?? 0}
        totalLost={portfolio!.total_lost_xlm ?? 0}
        pendingClaimsCount={pendingCount}
      />

      {/* Bet history */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-semibold">Bet History</h2>
          {totalPages > 1 && (
            <span className="text-xs text-gray-400">
              Page {currentPage} of {totalPages}
            </span>
          )}
        </div>
        <BetHistoryTable
          bets={displayedBets}
          markets={marketsMap}
          onClaim={claimWinnings}
          onRefund={claimRefund}
        />
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-xs text-gray-400" data-testid="pagination-controls">
            <span>
              {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, totalBets)} of {totalBets} bets
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => router.push(`/portfolio?page=${currentPage - 1}`)}
                disabled={currentPage <= 1}
                aria-label="Previous page"
                className="min-h-[32px] px-3 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed font-medium text-white transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => router.push(`/portfolio?page=${currentPage + 1}`)}
                disabled={currentPage >= totalPages}
                aria-label="Next page"
                className="min-h-[32px] px-3 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed font-medium text-white transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
        {hasNextPage && (
          <div className="mt-6 flex justify-center">
            <button
              onClick={loadNextPage}
              disabled={isFetchingNextPage}
              className="px-6 py-2.5 rounded-xl bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-sm font-semibold text-white transition-colors border border-gray-700 hover:border-gray-600"
            >
              {isFetchingNextPage ? 'Loading more bets…' : 'Load more'}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
