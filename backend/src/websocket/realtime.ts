import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import jwt from 'jsonwebtoken';
import type Redis from 'ioredis';
import { logger } from '../utils/logger';
import type { RankUpdate } from '../models/Engagement';
import { toMarketEventDTO } from '../dto/market.dto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const AUTH_TIMEOUT_MS = 5_000; // 5 seconds to send auth message

// ---------------------------------------------------------------------------
// Connection flooding protection — limits per IP
// ---------------------------------------------------------------------------
/** Maximum simultaneous WebSocket connections allowed per IP address. */
const MAX_CONNECTIONS_PER_IP = 10;

// ---------------------------------------------------------------------------
// Per-client message rate limiter — token bucket, max 20 messages/sec per client
// ---------------------------------------------------------------------------
const CLIENT_RATE_LIMIT = 20; // max messages per window
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
const MARKET_EVENTS_CHANNEL = 'websocket:market-events';
const AMM_MARKET_EVENTS_CHANNEL = 'market_events';

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------
export type ActivityEvent =
  | {
      type: 'trade';
      marketId: string;
      outcomeId: string;
      side: string;
      sharesAmount: number;
      priceBps: number;
      timestamp: string;
    }
  | { type: 'dispute'; marketId: string; proposedOutcomeId: string }
  | {
      type: 'market:resolved';
      marketId: string;
      outcome: string;
      winner_odds: number;
      timestamp: string;
    }
  | { type: 'resolved'; marketId: string; winningOutcomeId: string }
  | { type: 'cancelled'; marketId: string }
  | { type: 'market_update'; marketId: string; eventType: string; data: Record<string, unknown> }
  | { type: 'market_updated'; marketId: string; data: Record<string, unknown> }
  | { type: 'market_locked'; marketId: string; data?: Record<string, unknown> }
  | { type: 'market_resolved'; marketId: string; data?: Record<string, unknown> }
  | { type: 'market_cancelled'; marketId: string; data?: Record<string, unknown> }
  | {
      type: 'leaderboard_rank_update';
      userId: string;
      rank: number;
      currentStreak?: number;
      timestamp: string;
    }
  | {
      type: 'leaderboard_rank';
      marketId: string;
      address: string;
      rank: number | null;
      score: number;
      timestamp: string;
    }
  | { type: 'bet_count_update'; marketId: string; betCount: number; timestamp: string }
  | {
      type: 'indexer_status';
      status: 'running' | 'idle' | 'error' | 'syncing';
      currentLedger: number;
      targetLedger: number;
      timestamp: string;
    };

export type MarketCreatedEvent = {
  type: 'market:created';
  marketId: string;
  fighterA: string;
  fighterB: string;
};

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

type ClientMessage = {
  type: string;
  token?: unknown;
  channel?: unknown;
  marketId?: unknown;
  leaderboardId?: unknown;
};

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
  private readonly upgradeServer: Server;
  private readonly instanceId = randomUUID();
  private readonly redisPublisher?: Redis;
  private readonly redisSubscriber?: Redis;
  private readonly upgradeHandler: (
    req: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer
  ) => void;
  // marketId → set of subscribed sockets
  private subscriptions = new Map<string, Set<WebSocket>>();
  // leaderboardId → set of subscribed sockets
  private leaderboardSubscriptions = new Map<string, Set<WebSocket>>();
  // global leaderboard subscriptions
  private globalLeaderboardSubs = new Set<WebSocket>();
  private globalMarketCreatedSubs = new Set<WebSocket>();
  private rateLimiter = new MarketRateLimiter();
  private clientRateLimiter = new ClientRateLimiter();
  // Track authenticated connections
  private authScopes = new WeakMap<WebSocket, 'full' | 'activity'>();
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

  constructor(server: Server, redisClient?: Redis) {
    this.upgradeServer = server;
    this.wss = new WebSocketServer({ noServer: true });
    this.upgradeHandler = (req, socket, head) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/ws' && pathname !== '/') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    };
    server.on('upgrade', this.upgradeHandler);
    if (redisClient) {
      this.redisPublisher = redisClient.duplicate();
      this.redisSubscriber = redisClient.duplicate();
      this.redisSubscriber.on('message', (channel, message) => {
        if (channel === MARKET_EVENTS_CHANNEL) {
          this.receiveRedisEvent(message);
        } else if (channel === AMM_MARKET_EVENTS_CHANNEL) {
          this.receiveAmmRedisEvent(message);
        }
      });
      void this.redisSubscriber
        .subscribe(MARKET_EVENTS_CHANNEL, AMM_MARKET_EVENTS_CHANNEL)
        .catch((err) => {
          logger.error({ err }, 'Failed to subscribe to WebSocket market events');
        });
      this.redisPublisher.on('error', (err) => {
        logger.error({ err }, 'WebSocket Redis publisher error');
      });
      this.redisSubscriber.on('error', (err) => {
        logger.error({ err }, 'WebSocket Redis subscriber error');
      });
    }
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      // ── Connection flooding protection ────────────────────────────────────
      const ip = this._resolveIp(req);
      const currentCount = this.connectionsByIp.get(ip) ?? 0;
      if (currentCount >= MAX_CONNECTIONS_PER_IP) {
        ws.close(4029, 'Too many connections from your IP');
        logger.warn(
          { ip, count: currentCount },
          'WebSocket connection rejected: too many connections per IP'
        );
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
      this.subscriptions.forEach((sockets) => {
        activeSubscriptions += sockets.size;
      });

      // Emit metrics log
      logger.info(
        {
          connectedClients: totalClients,
          subscriptionRooms: this.subscriptions.size,
          activeSubscriptions,
        },
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

  private verifyToken(token: string): 'full' | 'activity' | null {
    const jwtSecret = process.env.JWT_ACCESS_SECRET ?? process.env.JWT_SECRET;
    if (!jwtSecret) return null;

    try {
      const payload = jwt.verify(token, jwtSecret) as jwt.JwtPayload;
      if (payload.type === 'access') return 'full';
      if (
        payload.sub === 'public-market-feed' &&
        payload.type === 'ws_activity' &&
        payload.scope === 'market_activity:read'
      )
        return 'activity';
      return null;
    } catch {
      return null;
    }
  }

  private handleMessage(ws: WebSocket, raw: string): void {
    // ── Per-client rate limit check ──────────────────────────────────────────
    if (!this.clientRateLimiter.allow(ws)) {
      return; // 429 frame already sent by the limiter
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      if (!/^\/(?:subscribe|unsubscribe) market:[^\s]{1,128}$/.test(raw)) return;
      msg = { type: 'command' };
    }

    if (!this.authScopes.has(ws)) {
      if (msg.type !== 'auth' || typeof msg.token !== 'string') {
        ws.close(4001, 'Expected auth message');
        return;
      }

      const scope = this.verifyToken(msg.token);
      if (!scope) {
        ws.close(4001, 'Invalid token');
        return;
      }

      this.authScopes.set(ws, scope);
      const timeout = this.authTimeouts.get(ws);
      if (timeout) {
        clearTimeout(timeout);
        this.authTimeouts.delete(ws);
      }
      return;
    }

    // ── Authenticated handlers with deduplication ────────────────────────────
    const channel = typeof msg.channel === 'string' ? msg.channel : '';
    const subscribeMatch = /^\/subscribe market:([^\s]{1,128})$/.exec(raw);
    const marketId =
      subscribeMatch?.[1] ??
      (msg.type === 'subscribe_activity' && typeof msg.marketId === 'string'
        ? msg.marketId
        : null) ??
      (msg.type === 'subscribe' && channel.startsWith('market:') ? channel.slice(7) : null);
    if (marketId) {
      this.subscribeMarket(ws, marketId);
      return;
    }

    const unsubscribeMatch = /^\/unsubscribe market:([^\s]{1,128})$/.exec(raw);
    const unsubscribeMarketId =
      unsubscribeMatch?.[1] ??
      (msg.type === 'unsubscribe' && channel.startsWith('market:') ? channel.slice(7) : null);
    if (unsubscribeMarketId) {
      this.unsubscribeMarket(ws, unsubscribeMarketId);
      return;
    }

    if (msg.type === 'subscribe_market_created') {
      this.globalMarketCreatedSubs.add(ws);
      return;
    }

    if (msg.type === 'subscribe_leaderboard') {
      if (this.authScopes.get(ws) !== 'full') {
        ws.send(JSON.stringify({ type: 'error', code: 403, message: 'INSUFFICIENT_SCOPE' }));
        return;
      }

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
      if (this.authScopes.get(ws) !== 'full') return;

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

  private subscribeMarket(ws: WebSocket, marketId: string): void {
    let markets = this.subscribedMarkets.get(ws);
    if (!markets) {
      markets = new Set<string>();
      this.subscribedMarkets.set(ws, markets);
    }
    if (markets.has(marketId)) return;
    markets.add(marketId);
    if (!this.subscriptions.has(marketId)) {
      this.subscriptions.set(marketId, new Set());
    }
    this.subscriptions.get(marketId)!.add(ws);
  }

  private unsubscribeMarket(ws: WebSocket, marketId: string): void {
    this.subscribedMarkets.get(ws)?.delete(marketId);
    const sockets = this.subscriptions.get(marketId);
    sockets?.delete(ws);
    if (sockets?.size === 0) this.subscriptions.delete(marketId);
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
    this.globalMarketCreatedSubs.delete(ws);

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

  /** Publish an activity event to all subscribers of the market. */
  publish(event: ActivityEvent): void {
    if ('marketId' in event && typeof event.marketId === 'string' && event.marketId) {
      const { marketId } = event;
      if (event.type !== 'market:resolved' && !this.rateLimiter.allow(marketId)) return;

      this.dispatchMarketEvent(event);
      if (this.redisPublisher) {
        void this.redisPublisher
          .publish(MARKET_EVENTS_CHANNEL, JSON.stringify({ origin: this.instanceId, event }))
          .catch((err) =>
            logger.error({ err, marketId }, 'Failed to publish WebSocket market event')
          );
      }
      return;
    }

    if (
      'leaderboardId' in event &&
      typeof event.leaderboardId === 'string' &&
      event.leaderboardId
    ) {
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

  private receiveRedisEvent(message: string): void {
    try {
      const envelope = JSON.parse(message) as { origin?: unknown; event?: unknown };
      if (
        envelope.origin === this.instanceId ||
        !envelope.event ||
        typeof envelope.event !== 'object'
      )
        return;
      const event = envelope.event as ActivityEvent;
      if (
        !('marketId' in event) ||
        typeof event.marketId !== 'string' ||
        !event.marketId ||
        typeof event.type !== 'string'
      )
        return;
      this.dispatchMarketEvent(event);
    } catch (err) {
      logger.warn({ err }, 'Ignoring malformed WebSocket market event from Redis');
    }
  }

  private receiveAmmRedisEvent(message: string): void {
    try {
      const event = JSON.parse(message) as {
        type?: unknown;
        market_id?: unknown;
        tier?: unknown;
        outcome?: unknown;
        amount?: unknown;
        odds?: unknown;
        tokens_received?: unknown;
        timestamp?: unknown;
      };
      if (event.type !== 'bet_executed' || typeof event.market_id !== 'string' || !event.market_id) {
        return;
      }
      this.dispatchMarketEvent({
        type: 'market_updated',
        marketId: event.market_id,
        data: {
          ...(typeof event.tier === 'number' && { tier: event.tier }),
          ...(typeof event.outcome === 'string' && { outcome: event.outcome }),
          ...(typeof event.amount === 'number' && { amount: event.amount }),
          ...(typeof event.odds === 'number' && { odds: event.odds }),
          ...(typeof event.tokens_received === 'number' && {
            tokens_received: event.tokens_received,
          }),
          ...(typeof event.timestamp === 'string' && { timestamp: event.timestamp }),
        },
      });
    } catch (err) {
      logger.warn({ err }, 'Ignoring malformed AMM market event from Redis');
    }
  }

  private dispatchMarketEvent(event: ActivityEvent): void {
    if (!('marketId' in event)) return;
    const marketId = event.marketId;
    const sockets = this.subscriptions.get(marketId);
    if (!sockets?.size) return;

    const events: ActivityEvent[] = [event];
    if (event.type === 'trade') {
      events.push({
        type: 'market_updated',
        marketId,
        data: {
          outcomeId: event.outcomeId,
          side: event.side,
          sharesAmount: event.sharesAmount,
          priceBps: event.priceBps,
          timestamp: event.timestamp,
        },
      });
    } else if (event.type === 'market_update') {
      const canonicalTypes: Record<
        string,
        'market_updated' | 'market_locked' | 'market_resolved' | 'market_cancelled'
      > = {
        bet_placed: 'market_updated',
        odds_changed: 'market_updated',
        market_locked: 'market_locked',
        market_resolved: 'market_resolved',
        market_cancelled: 'market_cancelled',
      };
      const canonicalType = canonicalTypes[event.eventType];
      if (canonicalType) events.push({ type: canonicalType, marketId, data: event.data });
    } else if (event.type === 'resolved' || event.type === 'market:resolved') {
      events.push({
        type: 'market_resolved',
        marketId,
        data:
          event.type === 'resolved'
            ? { winningOutcomeId: event.winningOutcomeId }
            : { outcome: event.outcome, winner_odds: event.winner_odds },
      });
    } else if (event.type === 'cancelled') {
      events.push({ type: 'market_cancelled', marketId });
    }

    for (const item of events) {
      const payload = JSON.stringify(toMarketEventDTO(item));
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  }

  publishMarketCreated(event: MarketCreatedEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.globalMarketCreatedSubs) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  /** Publish a bet count update to market subscribers. */
  publishBetCountUpdate(marketId: string, betCount: number): void {
    const event = {
      type: 'bet_count_update' as const,
      marketId,
      betCount,
      timestamp: new Date().toISOString(),
    };
    this.publish(event);
  }

  publishLeaderboardUpdate(
    event: LeaderboardRankUpdateEvent | { userId: string; rank: number; currentStreak: number }
  ): void {
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
    this.upgradeServer.off('upgrade', this.upgradeHandler);
    this.redisPublisher?.disconnect();
    this.redisSubscriber?.disconnect();
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
    dist['market:created'] = this.globalMarketCreatedSubs.size;
    return dist;
  }
}

// Singleton — initialised once in src/index.ts
let _feed: ActivityFeed | null = null;

export function initActivityFeed(server: Server, redisClient?: Redis): ActivityFeed {
  _feed = new ActivityFeed(server, redisClient);
  return _feed;
}

export function getActivityFeed(): ActivityFeed {
  if (!_feed) throw new Error('ActivityFeed not initialised');
  return _feed;
}

export function broadcastMarketResolved(
  marketId: string,
  outcome: string,
  winner_odds: number
): void {
  _feed?.publish({
    type: 'market:resolved',
    marketId,
    outcome,
    winner_odds,
    timestamp: new Date().toISOString(),
  });
}
