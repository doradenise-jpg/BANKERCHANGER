import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
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
  | { type: 'cancelled'; marketId: string }
  | { type: 'market_update'; marketId: string; eventType: string; data: Record<string, unknown> }
  | { type: 'leaderboard_rank_update'; userId: string; rank: number; currentStreak?: number; timestamp: string }
  | { type: 'leaderboard_rank'; marketId: string; address: string; rank: number | null; score: number; timestamp: string }
  | { type: 'indexer_status'; status: 'running' | 'idle' | 'error' | 'syncing'; currentLedger: number; targetLedger: number; timestamp: string };

/** Pushed to leaderboard subscribers whenever one or more ranks change. */
export interface LeaderboardRankEvent {
  type: 'leaderboard_rank_update';
  updates: RankUpdate[];
  timestamp: string;
}

export type LeaderboardRankUpdateEvent = {
  type: 'leaderboard_rank_update';
  leaderboardId?: string;
  userId: string;
  rank: number;
  score?: number;
  currentStreak?: number;
  displayName?: string;
  timestamp: string;
};

type AuthMsg = { type: 'auth'; token: string };
type SubscribeMsg =
  | { type: 'subscribe_activity'; marketId: string }
  | { type: 'subscribe_leaderboard'; leaderboardId?: string }
  | { type: 'unsubscribe_leaderboard'; leaderboardId?: string };

export type LeaderboardChannel = 'global' | 'referrals';

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
  // leaderboardId → set of subscribed sockets
  private leaderboardSubscriptions = new Map<string, Set<WebSocket>>();
  // global leaderboard subscriptions
  private globalLeaderboardSubs = new Set<WebSocket>();
  private rateLimiter = new MarketRateLimiter();
  // Track authenticated connections
  private authenticated = new WeakSet<WebSocket>();
  // Track auth timeout timers per socket
  private authTimeouts = new WeakMap<WebSocket, NodeJS.Timeout>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
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
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

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

      this.authenticated.add(ws);
      const timeout = this.authTimeouts.get(ws);
      if (timeout) {
        clearTimeout(timeout);
        this.authTimeouts.delete(ws);
      }
      return;
    }

    // Authenticated handlers
    if (msg.type === 'subscribe_activity' && typeof msg.marketId === 'string') {
      if (!this.subscriptions.has(msg.marketId)) {
        this.subscriptions.set(msg.marketId, new Set());
      }
      this.subscriptions.get(msg.marketId)!.add(ws);
      return;
    }

    if (msg.type === 'subscribe_leaderboard') {
      this.globalLeaderboardSubs.add(ws);
      if (msg.leaderboardId && typeof msg.leaderboardId === 'string') {
        if (!this.leaderboardSubscriptions.has(msg.leaderboardId)) {
          this.leaderboardSubscriptions.set(msg.leaderboardId, new Set());
        }
        this.leaderboardSubscriptions.get(msg.leaderboardId)!.add(ws);
      }
      return;
    }

    if (msg.type === 'unsubscribe_leaderboard') {
      this.globalLeaderboardSubs.delete(ws);
      if (msg.leaderboardId && typeof msg.leaderboardId === 'string') {
        this.leaderboardSubscriptions.get(msg.leaderboardId)?.delete(ws);
      }
      return;
    }
  }

  private cleanupSocket(ws: WebSocket): void {
    const timeout = this.authTimeouts.get(ws);
    if (timeout) {
      clearTimeout(timeout);
      this.authTimeouts.delete(ws);
    }

    this.globalLeaderboardSubs.delete(ws);

    for (const [marketId, sockets] of this.subscriptions.entries()) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.subscriptions.delete(marketId);
      }
    }

    for (const [leaderboardId, sockets] of this.leaderboardSubscriptions.entries()) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.leaderboardSubscriptions.delete(leaderboardId);
      }
    }
  }

  /** Publish an activity event to subscribers. */
  publish(event: ActivityEvent | LeaderboardRankUpdateEvent): void {
    if ('marketId' in event && event.marketId) {
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

    if ('leaderboardId' in event && event.leaderboardId) {
      const sockets = this.leaderboardSubscriptions.get(event.leaderboardId);
      if (sockets?.size) {
        const payload = JSON.stringify(event);
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) ws.send(payload);
        }
      }
    }

    // Also broadcast to global leaderboard subscribers if it is a leaderboard event
    if (event.type === 'leaderboard_rank_update' && this.globalLeaderboardSubs.size) {
      const payload = JSON.stringify(event);
      for (const ws of this.globalLeaderboardSubs) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  }

  publishLeaderboardUpdate(event: LeaderboardRankUpdateEvent | { userId: string; rank: number; currentStreak: number }): void {
    if ('leaderboardId' in event || 'displayName' in event || 'score' in event) {
      this.publish(event as LeaderboardRankUpdateEvent);
    } else {
      const rankEvent: ActivityEvent = {
        type: 'leaderboard_rank_update',
        userId: event.userId,
        rank: event.rank,
        currentStreak: event.currentStreak,
        timestamp: new Date().toISOString(),
      };
      this.publish(rankEvent);
    }
  }

  emitLeaderboardRankUpdate(updates: RankUpdate[]): void {
    if (!updates.length || !this.globalLeaderboardSubs.size) return;

    const payload: LeaderboardRankEvent = {
      type: 'leaderboard_rank_update',
      updates,
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    for (const ws of this.globalLeaderboardSubs) {
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

export function tryGetActivityFeed(): ActivityFeed | null {
  return _feed;
}

export function getActivityFeedIfInitialized(): ActivityFeed | null {
  return _feed;
}
