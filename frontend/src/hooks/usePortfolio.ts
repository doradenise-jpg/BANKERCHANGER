// ============================================================
// BANKERCHANGER — usePortfolio Hook
// Cursor-based paginated portfolio hook using React Query useInfiniteQuery
// ============================================================

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Market, Portfolio, TxStatus } from '../types';
import { useWallet } from './useWallet';
import { fetchPortfolio } from '../services/api';
import { submitClaim, submitRefund } from '../services/wallet';

export interface UsePortfolioResult {
  portfolio: Portfolio | null;
  bets: any[];
  performance: PortfolioPerformance;
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

export interface PortfolioPerformance {
  totalInvestedXlm: number;
  currentValueXlm: number;
  unrealizedPnlXlm: number;
  unrealizedPnlPercent: number;
}

interface MarketMultipliers {
  fighter_a: number;
  fighter_b: number;
  draw: number;
}

interface LiveMarketOdds {
  market_id: string;
  fighter_a: { multiplier: number };
  fighter_b: { multiplier: number };
  draw: { multiplier: number };
}

type PortfolioBet = NonNullable<Portfolio['active_bets']>[number];

function betCostXlm(bet: PortfolioBet): number {
  const amountXlm = Number(bet.amount_xlm);
  if (Number.isFinite(amountXlm) && amountXlm > 0) return amountXlm;
  const amountStroops = Number(bet.amount);
  return Number.isFinite(amountStroops) && amountStroops > 0 ? amountStroops / 10_000_000 : 0;
}

export function calculatePortfolioPerformance(
  activeBets: PortfolioBet[],
  markets: Market[],
  liveMultipliers: Record<string, MarketMultipliers> = {},
): PortfolioPerformance {
  const marketsById = new Map(markets.map((market) => [market.market_id, market]));
  let totalInvestedXlm = 0;
  let currentValueXlm = 0;

  for (const bet of activeBets) {
    const cost = betCostXlm(bet);
    totalInvestedXlm += cost;

    const marketId = bet.market_id;
    const market = marketId ? marketsById.get(marketId) : undefined;
    const liveMultiplier = marketId && bet.side ? liveMultipliers[marketId]?.[bet.side] : undefined;
    if (Number.isFinite(liveMultiplier) && liveMultiplier! > 0) {
      currentValueXlm += cost * liveMultiplier!;
      continue;
    }

    const pools = market;
    if (!pools) {
      currentValueXlm += cost;
      continue;
    }

    const poolA = Number(pools.pool_a);
    const poolB = Number(pools.pool_b);
    const poolDraw = Number(pools.pool_draw);
    const totalPool = Number(pools.total_pool) || poolA + poolB + poolDraw;
    const sidePool = bet.side === 'fighter_a' ? poolA : bet.side === 'fighter_b' ? poolB : poolDraw;
    if (![poolA, poolB, poolDraw, totalPool, sidePool].every(Number.isFinite) || sidePool <= 0 || totalPool <= 0) {
      currentValueXlm += cost;
      continue;
    }

    const feeBps = market?.fee_bps ?? 0;
    currentValueXlm += cost * (totalPool * (1 - feeBps / 10_000)) / sidePool;
  }

  const unrealizedPnlXlm = currentValueXlm - totalInvestedXlm;
  return {
    totalInvestedXlm,
    currentValueXlm,
    unrealizedPnlXlm,
    unrealizedPnlPercent: totalInvestedXlm > 0 ? unrealizedPnlXlm / totalInvestedXlm * 100 : 0,
  };
}

/**
 * Fetches the portfolio for the currently connected wallet.
 * Uses cursor-based pagination with 25 bets per page and React Query useInfiniteQuery.
 */
export function usePortfolio(markets: Market[] = []): UsePortfolioResult {
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
  const [liveMultipliers, setLiveMultipliers] = useState<Record<string, MarketMultipliers>>({});
  const activeMarketIds = useMemo(
    () => [...new Set((portfolio?.active_bets ?? []).map((bet) => bet.market_id).filter((id): id is string => Boolean(id)))],
    [portfolio?.active_bets],
  );
  const activeMarketIdsKey = activeMarketIds.join('|');
  const performance = useMemo(
    () => calculatePortfolioPerformance(portfolio?.active_bets ?? [], markets, liveMultipliers),
    [portfolio?.active_bets, markets, liveMultipliers],
  );

  useEffect(() => {
    setLiveMultipliers({});
  }, [activeMarketIdsKey]);

  useEffect(() => {
    if (activeMarketIds.length === 0 || typeof window === 'undefined' || typeof window.EventSource === 'undefined') return;
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    const streams = activeMarketIds.map((marketId) => {
      const stream = new window.EventSource(`${apiBaseUrl}/api/markets/${encodeURIComponent(marketId)}/odds/stream`);
      stream.onmessage = (event: MessageEvent) => {
        try {
          const odds = JSON.parse(event.data as string) as LiveMarketOdds;
          if (odds.market_id !== marketId) return;
          const multipliers = {
            fighter_a: Number(odds.fighter_a?.multiplier),
            fighter_b: Number(odds.fighter_b?.multiplier),
            draw: Number(odds.draw?.multiplier),
          };
          if (!Object.values(multipliers).every(Number.isFinite)) return;
          setLiveMultipliers((current) => ({ ...current, [marketId]: multipliers }));
        } catch {
          // Ignore malformed odds messages.
        }
      };
      return stream;
    });

    return () => streams.forEach((stream) => stream.close());
  }, [activeMarketIdsKey]);

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
    performance,
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
