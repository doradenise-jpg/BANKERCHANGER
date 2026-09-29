// ============================================================
// BANKERCHANGER — useMarket Hook
// ============================================================

import { useState, useEffect, useRef } from 'react';
import type { Market, OutcomeString } from '../types';
import { fetchActivityFeedToken, fetchMarketById, NotFoundError } from '../services/api';
import { queryClient } from '../providers/QueryProvider';

export interface UseMarketResult {
  market: Market | null;
  isLoading: boolean;
  error: Error | null;
  isNotFound: boolean;
}

/**
 * Fetches a single market's full detail by market_id.
 * Polls every 10 seconds while market.status is "open" or "locked".
 * Stops polling when status moves to "resolved" or "cancelled".

 */
export function useMarket(market_id: string): UseMarketResult {
  const [market, setMarket] = useState<Market | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isNotFound, setIsNotFound] = useState(false);
  const resolutionEventRef = useRef<{
    marketId: string;
    outcome: OutcomeString | null;
  } | null>(null);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const shouldPoll = (status: Market['status']): boolean =>
      status === 'open' || status === 'locked';

    const applyResolutionEvent = (data: Market): Market => {
      const resolution = resolutionEventRef.current;
      return resolution?.marketId === market_id
        ? { ...data, status: 'resolved', outcome: resolution.outcome ?? data.outcome }
        : data;
    };

    async function load() {
      try {
        const data = applyResolutionEvent(await fetchMarketById(market_id));
        if (cancelled) return;
        setMarket(data);
        setError(null);

        if (shouldPoll(data.status) && !intervalId) {
          intervalId = setInterval(async () => {
            try {
              const updated = applyResolutionEvent(await fetchMarketById(market_id));
              if (cancelled) return;
              setMarket(updated);

              if (!shouldPoll(updated.status)) {
                clearInterval(intervalId!);
                intervalId = null;
              }
            } catch (e) {
              if (!cancelled) setError(e as Error);
            }
          }, 10_000);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e as Error);
          if (e instanceof NotFoundError) setIsNotFound(true);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [market_id]);

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
          socket?.send(JSON.stringify({ type: 'subscribe_activity', marketId: market_id }));
        });
        socket.addEventListener('message', (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data as string) as {
              type?: string;
              marketId?: string;
              winningOutcomeId?: string;
              outcome?: string;
            };
            if (
              !['resolved', 'market:resolved', 'market_resolved'].includes(payload.type ?? '') ||
              payload.marketId !== market_id
            ) return;

            const rawOutcome = payload.winningOutcomeId ?? payload.outcome;
            const outcome =
              rawOutcome && ['fighter_a', 'fighter_b', 'draw', 'no_contest'].includes(rawOutcome)
                ? (rawOutcome as OutcomeString)
                : null;
            resolutionEventRef.current = { marketId: market_id, outcome };
            setMarket((current) => current
              ? { ...current, status: 'resolved', outcome: outcome ?? current.outcome }
              : current);
            void queryClient.invalidateQueries({ queryKey: ['market', market_id] });
          } catch {
            // Ignore malformed activity messages.
          }
        });
      } catch {
        // Keep the REST fetch/polling path available if token acquisition fails.
      }
    }

    void connect();
    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [market_id]);

  // Refresh when a claim succeeds for this market
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.marketId === market_id) {
        setMarket(null);
        setIsLoading(true);
        fetchMarketById(market_id)
          .then((m) => {
            setMarket(m);
            setError(null);
          })
          .catch((err) => setError(err as Error))
          .finally(() => setIsLoading(false));
      }
    };

    window.addEventListener('bankerchanger:claim_success', handler);
    return () => window.removeEventListener('bankerchanger:claim_success', handler);
  }, [market_id]);

  return { market, isLoading, error, isNotFound };
}
