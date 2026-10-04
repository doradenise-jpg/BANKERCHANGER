// ============================================================
// BANKERCHANGER — useMarketCountdown Hook
// Synchronizes with server time via /api/time to prevent client clock skew.
// ============================================================

import React, { useState, useEffect } from 'react';

const RESOLUTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_THRESHOLD_MS = 60 * 1000; // 60 seconds

let serverClockOffsetMs = 0;
let isOffsetSynced = false;

/**
 * Fetches server time from /api/time and calculates clock offset: serverTime - clientTime.
 */
export async function syncServerTimeOffset(): Promise<number> {
  try {
    const clientBefore = Date.now();
    const res = await fetch('/api/time');
    const clientAfter = Date.now();
    const clientMid = Math.round((clientBefore + clientAfter) / 2);
    const data = await res.json();
    const serverTime = data.serverTime ?? new Date(data.iso).getTime();
    serverClockOffsetMs = serverTime - clientMid;
    isOffsetSynced = true;
    return serverClockOffsetMs;
  } catch {
    return serverClockOffsetMs;
  }
}

/**
 * Returns the synchronized timestamp: Date.now() + serverOffset
 */
export function getSynchronizedNow(): number {
  return Date.now() + serverClockOffsetMs;
}

function compute(scheduled_at_ms: number, offsetMs: number): string {
  const now = Date.now() + offsetMs;
  if (now >= scheduled_at_ms + RESOLUTION_WINDOW_MS) return 'ENDED';
  if (now >= scheduled_at_ms) return 'LIVE';
  const diff = Math.floor((scheduled_at_ms - now) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Hook to retrieve clock offset and whether client clock is inaccurate (>60s skew).
 */
export function useServerClockSkew(): { offset: number; isClockInaccurate: boolean } {
  const [offset, setOffset] = useState<number>(serverClockOffsetMs);
  const [isClockInaccurate, setIsClockInaccurate] = useState<boolean>(
    Math.abs(serverClockOffsetMs) > CLOCK_SKEW_THRESHOLD_MS,
  );

  useEffect(() => {
    syncServerTimeOffset().then((newOffset) => {
      setOffset(newOffset);
      setIsClockInaccurate(Math.abs(newOffset) > CLOCK_SKEW_THRESHOLD_MS);
    });
  }, []);

  return { offset, isClockInaccurate };
}

/**
 * Banner component that displays a warning if client clock skew > 60 seconds.
 */
export function ClockWarningBanner(): JSX.Element | null {
  const { isClockInaccurate } = useServerClockSkew();
  if (!isClockInaccurate) return null;

  return (
    <div
      role="alert"
      className="bg-amber-900/40 border border-amber-500/50 text-amber-200 text-xs px-4 py-2 text-center"
    >
      ⚠️ Your system clock differs from the server by more than 60 seconds. Market countdowns and betting windows may be inaccurate.
    </div>
  );
}

/**
 * Returns a live countdown string synchronized with server time.
 */
export function useMarketCountdown(scheduled_at: string): string {
  const ms = new Date(scheduled_at).getTime();
  const [offset, setOffset] = useState<number>(serverClockOffsetMs);
  const [label, setLabel] = useState(() => compute(ms, serverClockOffsetMs));

  useEffect(() => {
    if (!isOffsetSynced) {
      syncServerTimeOffset().then((newOffset) => {
        setOffset(newOffset);
        setLabel(compute(ms, newOffset));
      });
    }
  }, [ms]);

  useEffect(() => {
    const id = setInterval(() => {
      setLabel(compute(ms, offset));
    }, 1000);
    return () => clearInterval(id);
  }, [ms, offset]);

  return label;
}
