import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
import type { RankUpdate } from '../models/Engagement';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';
const AUTH_TIMEOUT_MS = 5_000; // 5 seconds to send auth message

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------
export type ActivityEvent =
  | { type: 'trade'; marketId: string; outcomeId: string; side: string; sharesAmount: number; priceBps: number; timestamp: string }
  | { type: 'dispute'; marketId: string; proposedOutcomeId: string }
  | { type: 'resolved'; marketId: string; winningOutcomeId: string }
  | { type: 'market_update'; marketId: string; eventType: string; data: Record<string, unknown> };

  | { type: 'cancelled'; marketId: string };

  | { type: 'leaderboard_rank_update'; userId: string; rank: number; currentStreak: number; timestamp: string };

/** Pushed to leaderboard subscribers whenever one or more ranks change. */
export interface LeaderboardRankEvent {
  type: 'leaderboard_rank_update';
  updates: RankUpdate[];
  timestamp: string;
}

export type LeaderboardRankUpdateEvent = {
  type: 'leaderboard_rank_update';
  leaderboardId: string;
  userId: string;
  rank: number;
  score: number;
  displayName?: string;
  timestamp: string;
};

type AuthMsg = { type: 'auth'; token: string };
type SubscribeMsg = { type: 'subscribe_activity'; marketId: string };
type LeaderboardSubMsg = { type: 'subscribe_leaderboard' | 'unsubscribe_leaderboard' };

export type LeaderboardChannel = 'global' | 'referrals';

type SubscribeMsg =
  | { type: 'subscribe_activity'; marketId: string }
  | { type: 'subscribe_leaderboard'; leaderboardId: string };

// ---------------------------------------------------------------------------
// Rate limiter — token bucket, max 20 events/sec per market
// ---------------------------------------------------------------------------
const RATE_LIMIT = 20;
const WINDOW_MS = 1_000;

class MarketRateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>();

  allow(marketId: string): boolean {
    const now = Date.now();
    let entry = this.counts.get(marketId);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.counts.set(marketId, entry);
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// ActivityFeed
// ---------------------------------------------------------------------------
export class ActivityFeed {
  private wss: WebSocketServer;
  // marketId → set of subscribed sockets
  private subscriptions = new Map<string, Set<WebSocket>>();
  // sockets subscribed to the global leaderboard channel
  private leaderboardSubscriptions = new Set<WebSocket>();

  // sockets subscribed to global leaderboard rank updates
  private leaderboardSubs = new Set<WebSocket>();

  private leaderboardSubscriptions = new Map<string, Set<WebSocket>>();
  private rateLimiter = new MarketRateLimiter();
  // Track authenticated connections
  private authenticated = new WeakSet<WebSocket>();
  // Track auth timeout timers per socket
  private authTimeouts = new WeakMap<WebSocket, NodeJS.Timeout>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
      // Accept connection without verifying JWT in URL
      // Authentication happens in the first message
      
      // Set a timeout for the client to send auth message
      const authTimeout = setTimeout(() => {
        ws.close(4001, 'Authentication timeout');
      }, AUTH_TIMEOUT_MS);
      
      this.authTimeouts.set(ws, authTimeout);

      ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));
      ws.on('close', () => this.cleanupSocket(ws));
      ws.on('error', () => this.cleanupSocket(ws));
    });
    logger.info('ActivityFeed WebSocket server attached');
  }

  private verifyToken(token: string): boolean {
    try {
      jwt.verify(token, JWT_SECRET);
      return true;
    } catch {
      return false;
    }
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // If not authenticated, expect auth message
    if (!this.authenticated.has(ws)) {
      const authMsg = msg as AuthMsg;
      if (authMsg.type !== 'auth' || typeof authMsg.token !== 'string') {
        ws.close(4001, 'Expected auth message');
        return;
      }

      if (!this.verifyToken(authMsg.token)) {
        ws.close(4001, 'Invalid token');
        return;
      }

      // Authentication successful
      this.authenticated.add(ws);
      
      // Clear the auth timeout
      const timeout = this.authTimeouts.get(ws);
      if (timeout) {
        clearTimeout(timeout);
        this.authTimeouts.delete(ws);
      }

      return;
    }

    // Authenticated: leaderboard rank-update subscription (no per-market key)
    const leaderboardMsg = msg as LeaderboardSubMsg;
    if (leaderboardMsg.type === 'subscribe_leaderboard') {
      this.leaderboardSubs.add(ws);
      return;
    }
    if (leaderboardMsg.type === 'unsubscribe_leaderboard') {
      this.leaderboardSubs.delete(ws);
      return;
    }

    // Authenticated: handle subscription messages
    const subMsg = msg as SubscribeMsg & { channel?: LeaderboardChannel };
    if (subMsg.type === 'subscribe_leaderboard') {
      this.leaderboardSubscriptions.add(ws);
      return;
    }

    const { type, marketId } = subMsg;
    if (type !== 'subscribe_activity' || typeof marketId !== 'string') return;

    if (!this.subscriptions.has(marketId)) {
      this.subscriptions.set(marketId, new Set());

    const msgData = msg as SubscribeMsg;
    if (msgData.type === 'subscribe_activity' && typeof msgData.marketId === 'string') {
      if (!this.subscriptions.has(msgData.marketId)) {
        this.subscriptions.set(msgData.marketId, new Set());
      }
      this.subscriptions.get(msgData.marketId)!.add(ws);
      return;
    }

    if (msgData.type === 'subscribe_leaderboard' && typeof msgData.leaderboardId === 'string') {
      if (!this.leaderboardSubscriptions.has(msgData.leaderboardId)) {
        this.leaderboardSubscriptions.set(msgData.leaderboardId, new Set());
      }
      this.leaderboardSubscriptions.get(msgData.leaderboardId)!.add(ws);
    }
  }

  private cleanupSocket(ws: WebSocket): void {
    // Clear auth timeout if still pending
    const timeout = this.authTimeouts.get(ws);
    if (timeout) {
      clearTimeout(timeout);
      this.authTimeouts.delete(ws);
    }

    // Remove from subscriptions
    for (const [marketId, sockets] of this.subscriptions.entries()) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.subscriptions.delete(marketId);
      }
    }
    this.leaderboardSubscriptions.delete(ws);


    this.leaderboardSubs.delete(ws);


    for (const [leaderboardId, sockets] of this.leaderboardSubscriptions.entries()) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.leaderboardSubscriptions.delete(leaderboardId);
      }
    }
  }

  /** Publish an activity event to all subscribers of the market. */
  publish(event: ActivityEvent | LeaderboardRankUpdateEvent): void {
    if ('marketId' in event) {
      const marketId = event.marketId;
      if (!this.rateLimiter.allow(marketId)) return;

      const sockets = this.subscriptions.get(marketId);
      if (!sockets?.size) return;

      const payload = JSON.stringify(event);
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
      return;
    }

    if ('leaderboardId' in event) {
      const leaderboardId = event.leaderboardId;
      const sockets = this.leaderboardSubscriptions.get(leaderboardId);
      if (!sockets?.size) return;

      const payload = JSON.stringify(event);
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  }

  publishLeaderboardUpdate(event: LeaderboardRankUpdateEvent): void {
    this.publish(event);
  }

  /** Broadcast a leaderboard rank update to all sockets subscribed to the leaderboard channel. */
  publishLeaderboardUpdate(update: {
    userId: string;
    rank: number;
    currentStreak: number;
  }): void {
    if (this.leaderboardSubscriptions.size === 0) return;

    const event: ActivityEvent = {
      type: 'leaderboard_rank_update',
      userId: update.userId,
      rank: update.rank,
      currentStreak: update.currentStreak,
      timestamp: new Date().toISOString(),
    };

    const payload = JSON.stringify(event);
    for (const ws of this.leaderboardSubscriptions) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);

  /**
   * Broadcast leaderboard rank changes to every subscribed client.
   * Called by the engagement service's rank-update listener.
   */
  emitLeaderboardRankUpdate(updates: RankUpdate[]): void {
    if (!updates.length || !this.leaderboardSubs.size) return;

    const payload: LeaderboardRankEvent = {
      type: 'leaderboard_rank_update',
      updates,
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    for (const ws of this.leaderboardSubs) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
  }

  close(): void {
    this.wss.close();
  }
}

// Singleton — initialised once in src/index.ts
let _feed: ActivityFeed | null = null;

export function initActivityFeed(server: Server): ActivityFeed {
  _feed = new ActivityFeed(server);
  return _feed;
}

export function getActivityFeed(): ActivityFeed {
  if (!_feed) throw new Error('ActivityFeed not initialised');
  return _feed;
}

/**
 * Like getActivityFeed(), but returns null instead of throwing when the
 * feed hasn't been initialised (e.g. a process that runs the indexer
 * without also hosting the HTTP/WebSocket server, or in unit tests).
 */
export function tryGetActivityFeed(): ActivityFeed | null {

 * Same as getActivityFeed, but returns null instead of throwing when the
 * feed hasn't been initialised (e.g. standalone scripts, tests) — for
 * callers like the indexer that should degrade gracefully rather than fail
 * event ingestion just because nothing is subscribed yet.
 */
export function getActivityFeedIfInitialized(): ActivityFeed | null {
  return _feed;
}
