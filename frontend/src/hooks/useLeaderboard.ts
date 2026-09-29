// ============================================================
// BANKERCHANGER — useLeaderboard Hook
// Fetches the global engagement leaderboard and subscribes to
// real-time WebSocket rank updates so new scores appear instantly.
// ============================================================

import { useEffect, useState, useCallback } from 'react';
import type { Leaderboard, LeaderboardEntry, MyLeaderboardRank } from '../types';
import { fetchLeaderboard, fetchMyLeaderboardRank } from '../services/api';

type LeaderboardRankEvent = {
  type: 'leaderboard_rank';
  marketId: string;
  address: string;
  rank: number | null;
  score: number;
  timestamp: string;
};

function getActivityFeedUrl(baseUrl: string): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const parsed = new URL(baseUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : parsed.protocol === 'http:' ? 'ws:' : null;
    if (!protocol) return null;

    parsed.protocol = protocol;
    return parsed.toString();
  } catch {
    return null;
  }
}

export interface UseLeaderboardResult {
  leaderboard: Leaderboard | null;
  /** The authenticated caller's own rank, when available. */
  myRank: MyLeaderboardRank | null;
  /** True when the caller's rank falls inside the visible top-N page. */
  isMyRankInTopN: boolean;
  isLoading: boolean;
  error: Error | null;
  /** Call to trigger a manual refetch */
  refetch: () => void;
}

const POLL_INTERVAL = 60_000;

/**
 * Fetches the engagement leaderboard, polling every 60s, and opens a
 * WebSocket subscription to the leaderboard feed so rank/score updates are
 * applied live without waiting for the next poll.
 *
 * Also fetches the authenticated caller's own rank so the UI can render a
 * sticky "Your rank" card for users outside the visible top-N.
 */
export function useLeaderboard(limit = 50): UseLeaderboardResult {
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [myRank, setMyRank] = useState<MyLeaderboardRank | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  const load = useCallback(async () => {
    try {
      const data = await fetchLeaderboard(limit);
      setLeaderboard(data);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setIsLoading(false);
    }
  }, [limit]);

  const loadMyRank = useCallback(async () => {
    try {
      const data = await fetchMyLeaderboardRank();
      setMyRank(data);
    } catch {
      // Not authenticated, or rank not yet established — leave the card hidden.
      setMyRank(null);
    }
  }, []);

  useEffect(() => {
    load();
    loadMyRank();
    const id = setInterval(() => {
      load();
      loadMyRank();
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [load, loadMyRank, tick]);

  // Live WebSocket updates.
  useEffect(() => {
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    const socketUrl = getActivityFeedUrl(apiBaseUrl);
    if (!socketUrl || typeof window === 'undefined' || typeof window.WebSocket === 'undefined') return;

    const socket = new window.WebSocket(socketUrl);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe_leaderboard' }));
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data as string) as Partial<LeaderboardRankEvent>;
        if (payload?.type !== 'leaderboard_rank' || payload.address === undefined) return;

        setLeaderboard((prev) => {
          if (!prev) return prev;
          const entry = payload as LeaderboardRankEvent;
          const entries = prev.entries.map((e) =>
            e.address === entry.address ? { ...e, score: entry.score, rank: entry.rank ?? e.rank } : e,
          );

          const known = entries.some((e) => e.address === entry.address);
          const nextEntries: LeaderboardEntry[] = known
            ? entries
            : [...entries, { rank: entry.rank ?? entries.length + 1, address: entry.address, predictions: 0, score: entry.score }];

          nextEntries.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
          return { entries: nextEntries.slice(0, limit).map((e, idx) => ({ ...e, rank: idx + 1 })), updatedAt: entry.timestamp };
        });
      } catch {
        // Ignore malformed leaderboard messages.
      }
    });

    return () => socket.close();
  }, [limit]);

  const isMyRankInTopN =
    myRank !== null && leaderboard !== null ? myRank.rank <= leaderboard.entries.length : false;

  return { leaderboard, myRank, isMyRankInTopN, isLoading, error, refetch };
}