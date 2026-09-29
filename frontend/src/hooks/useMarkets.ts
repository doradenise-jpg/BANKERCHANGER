// ============================================================
// BANKERCHANGER — useMarkets Hook
// Fetches and auto-refreshes the full market list.
// Contributors: implement the hook body.
// ============================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Market } from '../types';
import type { MarketFilters, PaginationParams } from '../services/api';
import { fetchActivityFeedToken, fetchMarketById, fetchMarkets } from '../services/api';
import { useOptionalToast } from '../components/ui/ToastProvider';

const POLL_INTERVAL = 30_000;

export interface UseMarketsResult {
  markets: Market[];
  newMarketIds: ReadonlySet<string>;
  total: number;
  isLoading: boolean;
  error: Error | null;
  /** Call to trigger a manual refetch */
  refetch: () => void;
}

/**
 * Fetches all boxing markets from the API.
 * Auto-polls every 30 seconds to pick up new markets and status changes.
 * Polling stops when the component using this hook unmounts.
 *
 * Returns stale data during a background refresh (isLoading stays false
 * to avoid layout flash — use a subtle spinner instead).
 */
export function useMarkets(filters?: MarketFilters, pagination?: PaginationParams): UseMarketsResult {
  const toast = useOptionalToast();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [newMarketIds, setNewMarketIds] = useState<Set<string>>(() => new Set());
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const marketsRef = useRef<Market[]>([]);
  const newMarketTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const handledMarketIds = useRef(new Set<string>());
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Serialize to stable strings so object identity changes don't retrigger effects
  const filtersKey = JSON.stringify(filters ?? null);
  const paginationKey = JSON.stringify(pagination ?? null);

  const fetchAndUpdate = useCallback(async () => {
    try {
      const response = await fetchMarkets(
        filtersKey !== 'null' ? (JSON.parse(filtersKey) as MarketFilters) : undefined,
        paginationKey !== 'null' ? (JSON.parse(paginationKey) as PaginationParams) : undefined,
      );
      marketsRef.current = response.markets;
      setMarkets(response.markets);
      setTotal(response.total);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setIsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, paginationKey]);

  // Reset interval and trigger immediate fetch
  const refetch = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    fetchAndUpdate();
    const id = setInterval(fetchAndUpdate, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchAndUpdate, tick]);

  useEffect(() => {
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    let socketUrl: string;
    try {
      const parsed = new URL(apiBaseUrl);
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      socketUrl = parsed.toString();
    } catch {
      return;
    }
    if (typeof window === 'undefined' || typeof window.WebSocket === 'undefined') return;

    let socket: WebSocket | null = null;
    let cancelled = false;

    async function connect() {
      try {
        const token = await fetchActivityFeedToken();
        if (cancelled) return;

        socket = new window.WebSocket(socketUrl);
        socket.addEventListener('open', () => {
          socket?.send(JSON.stringify({ type: 'auth', token }));
          socket?.send(JSON.stringify({ type: 'subscribe_market_created' }));
        });
        socket.addEventListener('message', (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data as string) as {
              type?: string;
              marketId?: string;
              fighterA?: string;
              fighterB?: string;
            };
            if (
              payload.type !== 'market:created' ||
              typeof payload.marketId !== 'string' ||
              !payload.marketId
            )
              return;

            const { marketId } = payload;
            if (!handledMarketIds.current.has(marketId)) {
              handledMarketIds.current.add(marketId);
              toastRef.current?.info(
                `New market: ${payload.fighterA || 'Fighter A'} vs ${payload.fighterB || 'Fighter B'}`,
              );
            }

            void fetchMarketById(marketId)
              .then((market) => {
                if (cancelled) return;
                const parsedFilters =
                  filtersKey !== 'null' ? (JSON.parse(filtersKey) as MarketFilters) : {};
                const parsedPagination =
                  paginationKey !== 'null' ? (JSON.parse(paginationKey) as PaginationParams) : {};
                if (parsedPagination.page && parsedPagination.page > 1) return;
                if (parsedFilters.status && market.status !== parsedFilters.status) return;
                if (
                  parsedFilters.weight_class &&
                  market.weight_class !== parsedFilters.weight_class
                )
                  return;
                if (
                  parsedFilters.search &&
                  !`${market.fighter_a} ${market.fighter_b}`
                    .toLowerCase()
                    .includes(parsedFilters.search.toLowerCase())
                )
                  return;

                const currentMarkets = marketsRef.current;
                const alreadyListed = currentMarkets.some((item) => item.market_id === marketId);
                const nextMarkets = [
                  market,
                  ...currentMarkets.filter((item) => item.market_id !== marketId),
                ].slice(0, parsedPagination.limit ?? 20);
                marketsRef.current = nextMarkets;
                setMarkets(nextMarkets);
                if (!alreadyListed) setTotal((current) => current + 1);

                const existingTimer = newMarketTimers.current.get(marketId);
                if (existingTimer) clearTimeout(existingTimer);
                setNewMarketIds((current) => new Set(current).add(marketId));
                newMarketTimers.current.set(
                  marketId,
                  setTimeout(() => {
                    setNewMarketIds((current) => {
                      const next = new Set(current);
                      next.delete(marketId);
                      return next;
                    });
                    newMarketTimers.current.delete(marketId);
                  }, 60_000),
                );
              })
              .catch(() => {
                return;
              });
          } catch {
            return;
          }
        });
      } catch {
        return;
      }
    }

    void connect();
    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [filtersKey, paginationKey]);

  useEffect(
    () => () => {
      for (const timer of newMarketTimers.current.values()) clearTimeout(timer);
      newMarketTimers.current.clear();
    },
    [],
  );

  return { markets, newMarketIds, total, isLoading, error, refetch };
}
