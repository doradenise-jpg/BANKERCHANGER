// ============================================================
// BANKERCHANGER — useMarketOdds Hook
// Live odds hook backed by WebSocket with fallback to SSE stream.
// Supports real-time updates and stale odds indicators.
// ============================================================

import { useEffect, useRef, useState, useCallback } from 'react';
import { fetchOdds, type MarketOdds, type OutcomeOdds } from '../../lib/api';
import type { MarketStatus } from '../types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL ?? API_BASE.replace(/^http/, 'ws');

/** Statuses where live odds are no longer meaningful */
const TERMINAL_STATUSES: MarketStatus[] = ['resolved', 'cancelled'];
const STALE_THRESHOLD_MS = 30_000; // 30 seconds

export interface UseMarketOddsResult {
  odds: MarketOdds | null;
  getOutcomeOdds(outcome: 'fighter_a' | 'fighter_b' | 'draw'): OutcomeOdds | null;
  isLoading: boolean;
  error: Error | null;
  isStale: boolean;
  lastUpdatedAt: number | null;
}

/**
 * Subscribes to live odds for a market via WebSocket `market:odds_update`.
 * Falls back to SSE and one-shot fetch for terminal markets.
 * Tracks timestamp and flags odds as stale if no update received in >30s.
 */
export function useMarketOdds(
  marketId: string,
  status?: MarketStatus,
): UseMarketOddsResult {
  const [odds, setOdds] = useState<MarketOdds | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [isStale, setIsStale] = useState<boolean>(false);

  const socketRef = useRef<WebSocket | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const updateOdds = useCallback((newOdds: MarketOdds) => {
    setOdds(newOdds);
    setLastUpdatedAt(Date.now());
    setIsStale(false);
    setIsLoading(false);
  }, []);

  // Periodic staleness check
  useEffect(() => {
    if (!lastUpdatedAt) return;

    const interval = setInterval(() => {
      if (Date.now() - lastUpdatedAt > STALE_THRESHOLD_MS) {
        setIsStale(true);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [lastUpdatedAt]);

  useEffect(() => {
    if (!marketId) return;

    setIsLoading(true);
    setError(null);

    const isTerminal = status != null && TERMINAL_STATUSES.includes(status);

    if (isTerminal) {
      // Terminal market — one-shot fetch, no stream needed
      fetchOdds(marketId)
        .then((data) => {
          updateOdds(data as MarketOdds);
        })
        .catch((err) => {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        });
      return;
    }

    // 1. Initial fetch for instant display
    fetchOdds(marketId)
      .then((data) => {
        updateOdds(data as MarketOdds);
      })
      .catch(() => {
        // Will continue to rely on WebSocket
      });

    // 2. Connect to WebSocket for real-time `market:odds_update`
    let ws: WebSocket | null = null;
    if (typeof window !== 'undefined' && typeof window.WebSocket !== 'undefined') {
      try {
        ws = new window.WebSocket(`${WS_BASE}/ws`);
        socketRef.current = ws;

        ws.onopen = () => {
          ws?.send(JSON.stringify({ type: 'subscribe_market', marketId }));
        };

        ws.onmessage = (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data);
            if (
              (payload.type === 'market:odds_update' || payload.event === 'market:odds_update') &&
              (payload.marketId === marketId || payload.data?.marketId === marketId || !payload.marketId)
            ) {
              const updatedOdds = payload.odds || payload.data?.odds || payload.data;
              if (updatedOdds) {
                updateOdds(updatedOdds as MarketOdds);
              }
            }
          } catch {
            // Ignore malformed messages
          }
        };

        ws.onerror = () => {
          // Fall back gracefully to SSE if WebSocket errors
          connectSSE();
        };
      } catch {
        connectSSE();
      }
    } else {
      connectSSE();
    }

    function connectSSE() {
      if (esRef.current) return;
      try {
        const es = new EventSource(`${API_BASE}/api/markets/${marketId}/odds/stream`);
        esRef.current = es;

        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as MarketOdds;
            updateOdds(data);
          } catch {
            // Ignore
          }
        };

        es.onerror = () => {
          es.close();
          esRef.current = null;
        };
      } catch {
        // SSE unsupported or network error
      }
    }

    return () => {
      if (ws) {
        ws.close();
        socketRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [marketId, status, updateOdds]);

  return {
    odds,
    getOutcomeOdds: (outcome: 'fighter_a' | 'fighter_b' | 'draw') => odds?.[outcome] ?? null,
    isLoading,
    error,
    isStale,
    lastUpdatedAt,
  };
}
