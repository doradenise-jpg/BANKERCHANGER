// backend/src/dto/market.dto.ts
//
// Whitelist projections for WebSocket broadcast payloads (issue #659).
// All market-room broadcasts MUST pass through toMarketEventDTO() before
// being serialised to JSON. This guarantees that private fields such as
// user_id and wallet_address are never sent to subscribers.

import type { ActivityEvent } from '../websocket/realtime';

// ---------------------------------------------------------------------------
// Public DTO shapes — only these fields are allowed in broadcast payloads
// ---------------------------------------------------------------------------

export interface TradeEventDTO {
  type: 'trade';
  marketId: string;
  outcomeId: string;
  side: string;
  sharesAmount: number;
  priceBps: number;
  timestamp: string;
}

export interface DisputeEventDTO {
  type: 'dispute';
  marketId: string;
  proposedOutcomeId: string;
}

export interface ResolvedEventDTO {
  type: 'resolved';
  marketId: string;
  winningOutcomeId: string;
}

export interface CancelledEventDTO {
  type: 'cancelled';
  marketId: string;
}

/**
 * Sanitised variant of `market_update` — the `data` field is stripped of any
 * private keys (user_id, wallet_address, and common alias variants).
 */
export interface MarketUpdateEventDTO {
  type: 'market_update';
  marketId: string;
  eventType: string;
  data: Record<string, unknown>;
}

export type MarketActivityEventDTO =
  | TradeEventDTO
  | DisputeEventDTO
  | ResolvedEventDTO
  | CancelledEventDTO
  | MarketUpdateEventDTO;

// ---------------------------------------------------------------------------
// Private-field blocklist — never allowed in market-room broadcasts
// ---------------------------------------------------------------------------
const BLOCKED_KEYS = new Set([
  'user_id',
  'userId',
  'wallet_address',
  'walletAddress',
  'bettor_address',
  'bettorAddress',
  'email',
  'password',
  'passwordHash',
  'twoFactorSecret',
  'resetTokenHash',
  'sessionVersion',
  'stellarSecretKey',
  'privateKey',
]);

/**
 * Recursively removes blocked private keys from a plain object.
 * Only processes plain objects — arrays and primitives are passed through.
 */
function stripPrivateFields(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (BLOCKED_KEYS.has(key)) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = stripPrivateFields(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Projects an `ActivityEvent` to its public DTO shape.
 *
 * - For known event types, only explicitly whitelisted fields are included.
 * - For `market_update`, the `data` payload is sanitised by stripping all
 *   blocked private keys (see BLOCKED_KEYS above).
 * - Unknown event types are returned stripped of all private fields as a
 *   best-effort fallback.
 *
 * @returns A sanitised DTO safe to broadcast to market-room subscribers.
 */
export function toMarketEventDTO(event: ActivityEvent): MarketActivityEventDTO | ActivityEvent {
  switch (event.type) {
    case 'trade':
      return {
        type: 'trade',
        marketId: event.marketId,
        outcomeId: event.outcomeId,
        side: event.side,
        sharesAmount: event.sharesAmount,
        priceBps: event.priceBps,
        timestamp: event.timestamp,
      } satisfies TradeEventDTO;

    case 'dispute':
      return {
        type: 'dispute',
        marketId: event.marketId,
        proposedOutcomeId: event.proposedOutcomeId,
      } satisfies DisputeEventDTO;

    case 'resolved':
      return {
        type: 'resolved',
        marketId: event.marketId,
        winningOutcomeId: event.winningOutcomeId,
      } satisfies ResolvedEventDTO;

    case 'cancelled':
      return {
        type: 'cancelled',
        marketId: event.marketId,
      } satisfies CancelledEventDTO;

    case 'market_update':
      return {
        type: 'market_update',
        marketId: event.marketId,
        eventType: event.eventType,
        // Strip any private keys embedded in the arbitrary data payload
        data: stripPrivateFields(event.data),
      } satisfies MarketUpdateEventDTO;

    // Leaderboard and indexer events are not broadcast to market rooms,
    // but if they somehow arrive here, strip private fields as a safety net.
    default:
      return stripPrivateFields(event as unknown as Record<string, unknown>) as unknown as ActivityEvent;
  }
}
