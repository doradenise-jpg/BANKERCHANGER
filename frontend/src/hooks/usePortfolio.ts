// ============================================================
// BANKERCHANGER — usePortfolio Hook
// Cursor-based paginated portfolio hook using React Query useInfiniteQuery
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import type { Portfolio, TxStatus } from '../types';
import { useWallet } from './useWallet';
import { fetchPortfolio } from '../services/api';
import { submitClaim, submitRefund } from '../services/wallet';

export interface UsePortfolioResult {
  portfolio: Portfolio | null;
  bets: any[];
  isLoading: boolean;
  error: Error | null;
  claimTxStatus: TxStatus;
  page: number;
  limit: number;
  total: number;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  fetchNextPage: () => Promise<any>;
  loadNextPage: () => Promise<void>;
  /** Submits claim_winnings for a market contract. Refreshes portfolio after. */
  claimWinnings: (market_contract_address: string) => Promise<void>;
  /** Submits claim_refund for a cancelled market. Refreshes portfolio after. */
  claimRefund: (market_contract_address: string) => Promise<void>;
}

const PAGE_SIZE = 25;

/**
 * Fetches the portfolio for the currently connected wallet.
 * Uses cursor-based pagination with 25 bets per page and React Query useInfiniteQuery.
 */
export function usePortfolio(): UsePortfolioResult {
  const { address } = useWallet();
  const [claimTxStatus, setClaimTxStatus] = useState<TxStatus>({
    hash: null,
    status: 'idle',
    error: null,
  });

  // Query for portfolio summary data with caching
  const {
    data: portfolio = null,
    isLoading: portfolioLoading,
    error: portfolioError,
    refetch: refetchPortfolio,
  } = useQuery({
    queryKey: ['portfolio', address],
    queryFn: () => (address ? fetchPortfolio(address) : Promise.resolve(null)),
    enabled: !!address,
    staleTime: 30_000,
    gcTime: 60_000,
  });

  // Infinite query for bets using cursor-based pagination (25 per page)
  const {
    data: infiniteBetsData,
    isLoading: betsLoading,
    error: betsError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch: refetchBets,
  } = useInfiniteQuery({
    queryKey: ['bets', 'infinite', address],
    queryFn: async ({ pageParam = 0 }) => {
      if (!address) return { bets: [], total: 0, nextCursor: null };
      const res = await fetch(`/api/bets/${address}?cursor=${pageParam}&limit=${PAGE_SIZE}`);
      const data = await res.json();
      const betsList = data.bets ?? [];
      const totalCount = data.total ?? (betsList.length);
      const nextCursor = data.nextCursor !== undefined ? data.nextCursor : (betsList.length === PAGE_SIZE ? Number(pageParam) + PAGE_SIZE : null);
      return {
        bets: betsList,
        total: totalCount,
        nextCursor,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => (lastPage.nextCursor !== null ? lastPage.nextCursor : undefined),
    enabled: !!address,
    staleTime: 30_000,
    gcTime: 60_000,
  });

  const bets = infiniteBetsData?.pages.flatMap((page) => page.bets) ?? [];
  const total = infiniteBetsData?.pages[0]?.total ?? bets.length;
  const isLoading = portfolioLoading || betsLoading;
  const error = portfolioError ?? betsError ?? null;

  // Refresh portfolio on claim success event
  useEffect(() => {
    const handler = () => {
      refetchPortfolio();
      refetchBets();
    };
    window.addEventListener('bankerchanger:claim_success', handler);
    return () => window.removeEventListener('bankerchanger:claim_success', handler);
  }, [refetchPortfolio, refetchBets]);

  const loadNextPage = useCallback(async () => {
    if (hasNextPage && !isFetchingNextPage) {
      await fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const runClaim = useCallback(async (fn: () => Promise<string>) => {
    setClaimTxStatus({ hash: null, status: 'signing', error: null });
    try {
      const hash = await fn();
      setClaimTxStatus({ hash, status: 'success', error: null });
      await refetchPortfolio();
      await refetchBets();
    } catch (e: any) {
      setClaimTxStatus({ hash: null, status: 'error', error: e?.message ?? String(e) });
    }
  }, [refetchPortfolio, refetchBets]);

  const claimWinnings = useCallback(
    (market_contract_address: string) =>
      runClaim(() => submitClaim(market_contract_address)),
    [runClaim],
  );

  const claimRefund = useCallback(
    (market_contract_address: string) =>
      runClaim(() => submitRefund(market_contract_address)),
    [runClaim],
  );

  return {
    portfolio,
    bets,
    isLoading,
    error,
    claimTxStatus,
    page: 1,
    limit: PAGE_SIZE,
    total,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    loadNextPage,
    claimWinnings,
    claimRefund,
  };
}
