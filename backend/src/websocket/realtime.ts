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
// Connection flooding protection — limits per IP
// ---------------------------------------------------------------------------
/** Maximum simultaneous WebSocket connections allowed per IP address. */
const MAX_CONNECTIONS_PER_IP = 10;

// ---------------------------------------------------------------------------
// Per-client message rate limiter — token bucket, max 20 messages/sec per client
// ---------------------------------------------------------------------------
const CLIENT_RATE_LIMIT = 20;       // max messages per window
const CLIENT_RATE_WINDOW_MS = 1_000; // rolling window in milliseconds

// ---------------------------------------------------------------------------
// Heartbeat / ping-pong settings
// ---------------------------------------------------------------------------
/** Interval between server-initiated pings (ms). */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Maximum number of consecutive missed pings before the connection is terminated. */
const HEARTBEAT_MAX_MISSED = 2;

// ---------------------------------------------------------------------------
// Market-level broadcast rate limiter — token bucket, max 20 events/sec per market
// ---------------------------------------------------------------------------
const RATE_LIMIT = 20;
const WINDOW_MS = 1_000;

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
// Market-level broadcast rate limiter — token bucket, max 20 events/sec per market
// ---------------------------------------------------------------------------
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
// Per-client connection rate limiter — sliding window token bucket
// ---------------------------------------------------------------------------
class ClientRateLimiter {
  private clients = new WeakMap<WebSocket, { count: number; resetAt: number }>();

  /**
   * Returns true and increments the counter if the client is within rate limits.
   * Sends a 429 RATE_LIMIT_EXCEEDED frame and returns false if over the limit.
   */
  allow(ws: WebSocket): boolean {
    const now = Date.now();
    let entry = this.clients.get(ws);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + CLIENT_RATE_WINDOW_MS };
      this.clients.set(ws, entry);
    }
    if (entry.count >= CLIENT_RATE_LIMIT) {
      // Notify the client with a structured error frame before refusing
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', code: 429, message: 'RATE_LIMIT_EXCEEDED' }));
      }
      return false;
    }
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
  private clientRateLimiter = new ClientRateLimiter();
  // Track authenticated connections
  private authenticated = new WeakSet<WebSocket>();
  // Track auth timeout timers per socket
  private authTimeouts = new WeakMap<WebSocket, NodeJS.Timeout>();

  // ── Connection flooding protection ──────────────────────────────────────────
  /** IP address → current active connection count. */
  private connectionsByIp = new Map<string, number>();

  // ── Deduplication: track which rooms each socket has already joined ─────────
  /** Per-socket set of market IDs this socket has subscribed to (dedup). */
  private subscribedMarkets = new WeakMap<WebSocket, Set<string>>();
  /** Per-socket flag for global leaderboard dedup. */
  private subscribedGlobalLeaderboard = new WeakSet<WebSocket>();
  /** Per-socket set of named leaderboard IDs this socket has subscribed to. */
  private subscribedLeaderboards = new WeakMap<WebSocket, Set<string>>();

  // ── Heartbeat / ping-pong ───────────────────────────────────────────────────
  /** Per-socket count of consecutive missed heartbeats. */
  private missedHeartbeats = new WeakMap<WebSocket, number>();
  /** Server-wide heartbeat interval handle. */
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // ── Metrics ─────────────────────────────────────────────────────────────────
  private connectedClients = 0;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      // ── Connection flooding protection ────────────────────────────────────
      const ip = this._resolveIp(req);
      const currentCount = this.connectionsByIp.get(ip) ?? 0;
      if (currentCount >= MAX_CONNECTIONS_PER_IP) {
        ws.close(4029, 'Too many connections from your IP');
        logger.warn({ ip, count: currentCount }, 'WebSocket connection rejected: too many connections per IP');
        return;
      }
      this.connectionsByIp.set(ip, currentCount + 1);
      this.connectedClients++;

      // ── Auth timeout ──────────────────────────────────────────────────────
      const authTimeout = setTimeout(() => {
        ws.close(4001, 'Authentication timeout');
      }, AUTH_TIMEOUT_MS);
      this.authTimeouts.set(ws, authTimeout);

      // ── Heartbeat state ────────────────────────────────────────────────────
      this.missedHeartbeats.set(ws, 0);
      ws.on('pong', () => {
        // Client responded — reset missed count
        this.missedHeartbeats.set(ws, 0);
      });

      ws.on('message', (raw) => this.handleMessage(ws, raw.toString()));
      ws.on('close', () => this.cleanupSocket(ws, ip));
      ws.on('error', () => this.cleanupSocket(ws, ip));

      logger.debug({ ip, connectedClients: this.connectedClients }, 'WebSocket client connected');
    });

    // ── Start the server-wide heartbeat loop ──────────────────────────────────
    this._startHeartbeat();

    logger.info('ActivityFeed WebSocket server attached');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _resolveIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]!.trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private _startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const totalClients = this.wss.clients.size;
      let activeSubscriptions = 0;
      this.subscriptions.forEach((sockets) => { activeSubscriptions += sockets.size; });

      // Emit metrics log
      logger.info(
        { connectedClients: totalClients, subscriptionRooms: this.subscriptions.size, activeSubscriptions },
        'WebSocket heartbeat tick'
      );

      for (const ws of this.wss.clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;

        const missed = this.missedHeartbeats.get(ws) ?? 0;
        if (missed >= HEARTBEAT_MAX_MISSED) {
          // Too many missed pings — terminate the ghost connection
          ws.terminate();
          logger.warn('WebSocket ghost connection terminated after missed heartbeats');
          continue;
        }

        this.missedHeartbeats.set(ws, missed + 1);
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Allow Node.js to exit even if this timer is active
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
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
    // ── Per-client rate limit check ──────────────────────────────────────────
    if (!this.clientRateLimiter.allow(ws)) {
      return; // 429 frame already sent by the limiter
    }

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

    // ── Authenticated handlers with deduplication ────────────────────────────
    if (msg.type === 'subscribe_activity' && typeof msg.marketId === 'string') {
      // Deduplicate: ignore if already subscribed to this market
      let markets = this.subscribedMarkets.get(ws);
      if (!markets) {
        markets = new Set<string>();
        this.subscribedMarkets.set(ws, markets);
      }
      if (markets.has(msg.marketId)) {
        return; // already subscribed — drop duplicate request
      }
      markets.add(msg.marketId);

      if (!this.subscriptions.has(msg.marketId)) {
        this.subscriptions.set(msg.marketId, new Set());
      }
      this.subscriptions.get(msg.marketId)!.add(ws);
      return;
    }

    if (msg.type === 'subscribe_leaderboard') {
      // Deduplicate global leaderboard subscription
      if (!this.subscribedGlobalLeaderboard.has(ws)) {
        this.subscribedGlobalLeaderboard.add(ws);
        this.globalLeaderboardSubs.add(ws);
      }

      if (msg.leaderboardId && typeof msg.leaderboardId === 'string') {
        let leaderboards = this.subscribedLeaderboards.get(ws);
        if (!leaderboards) {
          leaderboards = new Set<string>();
          this.subscribedLeaderboards.set(ws, leaderboards);
        }
        if (!leaderboards.has(msg.leaderboardId)) {
          leaderboards.add(msg.leaderboardId);
          if (!this.leaderboardSubscriptions.has(msg.leaderboardId)) {
            this.leaderboardSubscriptions.set(msg.leaderboardId, new Set());
          }
          this.leaderboardSubscriptions.get(msg.leaderboardId)!.add(ws);
        }
      }
      return;
    }

    if (msg.type === 'unsubscribe_leaderboard') {
      this.globalLeaderboardSubs.delete(ws);
      // Allow re-subscribe after unsubscribe
      // (we can't delete from a WeakSet, but the subscription set is the source of truth)
      if (msg.leaderboardId && typeof msg.leaderboardId === 'string') {
        this.leaderboardSubscriptions.get(msg.leaderboardId)?.delete(ws);
        this.subscribedLeaderboards.get(ws)?.delete(msg.leaderboardId);
      }
      return;
    }
  }

  private cleanupSocket(ws: WebSocket, ip?: string): void {
    // ── Auth timeout ───────────────────────────────────────────────────────
    const timeout = this.authTimeouts.get(ws);
    if (timeout) {
      clearTimeout(timeout);
      this.authTimeouts.delete(ws);
    }

    // ── Connection count ──────────────────────────────────────────────────
    if (ip) {
      const count = this.connectionsByIp.get(ip) ?? 1;
      if (count <= 1) {
        this.connectionsByIp.delete(ip);
      } else {
        this.connectionsByIp.set(ip, count - 1);
      }
    }
    if (this.connectedClients > 0) this.connectedClients--;

    // ── Market subscriptions ──────────────────────────────────────────────
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

    logger.debug({ connectedClients: this.connectedClients }, 'WebSocket client disconnected');
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.wss.close();
  }

  // ── Metrics accessors (for health endpoints / monitoring) ──────────────────
  getConnectedClientCount(): number {
    return this.wss.clients.size;
  }

  getSubscriptionRoomCount(): number {
    return this.subscriptions.size + this.leaderboardSubscriptions.size;
  }

  getSubscriptionDistribution(): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const [marketId, sockets] of this.subscriptions.entries()) {
      dist[`market:${marketId}`] = sockets.size;
    }
    for (const [leaderboardId, sockets] of this.leaderboardSubscriptions.entries()) {
      dist[`leaderboard:${leaderboardId}`] = sockets.size;
    }
    dist['leaderboard:global'] = this.globalLeaderboardSubs.size;
    return dist;
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
