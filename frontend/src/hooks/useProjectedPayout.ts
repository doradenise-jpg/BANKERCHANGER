// ============================================================
// BOXMEOUT — useProjectedPayout Hook
// Pure client-side parimutuel payout preview.
// No API call — recalculates on market, outcome, or amount change.
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BetSide, Market } from '../types';

type ActivityTradeEvent = {
  type: 'trade';
  marketId: string;
  outcomeId: string;
  side: string;
  sharesAmount: number;
  priceBps: number;
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

function applyTradeEventToMarket(market: Market, event: ActivityTradeEvent): Market {
  const shares = Number.isFinite(event.sharesAmount) ? Math.max(0, event.sharesAmount) : 0;
  const priceBps = Number.isFinite(event.priceBps) ? Math.max(0, event.priceBps) : 0;
  if (shares <= 0 || priceBps <= 0) return market;

  const tradeValueStroops = BigInt(Math.round((shares * priceBps / 10_000) * 10_000_000));
  const poolDelta = tradeValueStroops;

  const poolA = BigInt(market.pool_a) + (event.outcomeId === 'fighter_a' ? poolDelta : 0n);
  const poolB = BigInt(market.pool_b) + (event.outcomeId === 'fighter_b' ? poolDelta : 0n);
  const poolDraw = BigInt(market.pool_draw) + (event.outcomeId === 'draw' ? poolDelta : 0n);

  return {
    ...market,
    pool_a: poolA.toString(),
    pool_b: poolB.toString(),
    pool_draw: poolDraw.toString(),
    total_pool: (poolA + poolB + poolDraw).toString(),
  };
}

/**
 * Calculates the projected payout for a bet using the parimutuel formula:
 *
 *   payout = (amount / side_pool_after) * total_pool_after * (1 - fee_bps / 10_000)
 *
 * where side_pool_after and total_pool_after include the user's bet amount.
 *
 * The hook also listens to the market activity feed so that a live trade event
 * can immediately refresh the preview without waiting for a full market reload.
 *
 * @param market  - The market to bet on (provides pool sizes and fee)
 * @param side    - Which outcome the user is betting on
 * @param amount  - Bet amount in XLM (as a number)
 * @returns Projected payout in XLM, or null if any input is missing/invalid
 */
export function useProjectedPayout(
  market: Market | null | undefined,
  side: BetSide | null | undefined,
  amount: number | null | undefined,
): number | null {
  const [debouncedTradeEvent, setDebouncedTradeEvent] = useState<ActivityTradeEvent | null>(null);
  const pendingTradeEventRef = useRef<ActivityTradeEvent | null>(null);
  const timeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  useEffect(() => {
    if (!market) return;

    const marketId = market.market_id ?? market.id?.toString();
    if (!marketId) return;

    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    const socketUrl = getActivityFeedUrl(apiBaseUrl);
    if (!socketUrl || typeof window === 'undefined' || typeof window.WebSocket === 'undefined') return;

    const socket = new window.WebSocket(socketUrl);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe_activity', marketId }));
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data as string) as Partial<ActivityTradeEvent> & { marketId?: string };
        if (payload?.type !== 'trade' || payload.marketId !== marketId) return;

        pendingTradeEventRef.current = payload as ActivityTradeEvent;
        if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => {
          setDebouncedTradeEvent(pendingTradeEventRef.current);
          timeoutRef.current = null;
        }, 1_000);
      } catch {
        // Ignore malformed activity messages.
      }
    });

    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      socket.close();
    };
  }, [market?.market_id, market?.id]);

  const liveMarket = useMemo(() => {
    if (!market) return null;
    if (!debouncedTradeEvent) return market;
    return applyTradeEventToMarket(market, debouncedTradeEvent);
  }, [market, debouncedTradeEvent]);

  return useMemo(() => {
    if (!liveMarket || !side || amount == null || amount <= 0) return null;

    // Convert XLM to stroops for integer arithmetic
    const STROOPS = 10_000_000n;
    const amountStroops = BigInt(Math.round(amount * 10_000_000));

    const poolA = BigInt(liveMarket.pool_a);
    const poolB = BigInt(liveMarket.pool_b);
    const poolDraw = BigInt(liveMarket.pool_draw);

    // Side pool before this bet
    const sidePoolBefore =
      side === 'fighter_a' ? poolA : side === 'fighter_b' ? poolB : poolDraw;

    // Pools after including this bet
    const sidePoolAfter = sidePoolBefore + amountStroops;
    const totalPoolAfter = poolA + poolB + poolDraw + amountStroops;

    // Zero-pool edge case: if side pool after is 0 (shouldn't happen since we add amount)
    if (sidePoolAfter === 0n) return null;

    // fee_bps is in basis points (0–10000); scale factor = 10000 - fee_bps
    const feeFactor = BigInt(10_000 - liveMarket.fee_bps);

    // payout_stroops = (amountStroops * totalPoolAfter * feeFactor) / (sidePoolAfter * 10_000)
    const payoutStroops =
      (amountStroops * totalPoolAfter * feeFactor) / (sidePoolAfter * 10_000n);

    // Convert back to XLM
    return Number(payoutStroops) / Number(STROOPS);
  }, [liveMarket, side, amount]);
}
