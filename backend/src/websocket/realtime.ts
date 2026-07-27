import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';
const AUTH_TIMEOUT_MS = 5000; // 5 seconds to authenticate after connection

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------
export type ActivityEvent =
  | { type: 'trade'; marketId: string; outcomeId: string; side: string; sharesAmount: number; priceBps: number; timestamp: string }
  | { type: 'dispute'; marketId: string; proposedOutcomeId: string }
  | { type: 'resolved'; marketId: string; winningOutcomeId: string };

type SubscribeMsg = { type: 'subscribe_activity'; marketId: string };
type AuthMsg = { type: 'auth'; token: string };
type IncomingMsg = AuthMsg | SubscribeMsg | { type: string };

// ---------------------------------------------------------------------------
// Connection state tracking
// ---------------------------------------------------------------------------
interface ConnectionState {
  authenticated: boolean;
  authTimer?: NodeJS.Timeout;
  requestId: string;
}

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
  private rateLimiter = new MarketRateLimiter();
  // Track connection state (authenticated, auth timer, request ID)
  private connectionStates = new WeakMap<WebSocket, ConnectionState>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const requestId = this.generateRequestId();
      const state: ConnectionState = {
        authenticated: false,
        requestId,
      };

      // Store connection state
      this.connectionStates.set(ws, state);

      // Set auth timeout: if no auth message received within 5 seconds, close
      state.authTimer = setTimeout(() => {
        if (!state.authenticated) {
          logger.warn(`[${requestId}] WebSocket connection closed: authentication timeout`);
          ws.close(4001, 'Authentication timeout');
          this.removeSocket(ws);
        }
      }, AUTH_TIMEOUT_MS);

      // Attach message handler
      ws.on('message', (raw) => this.handleMessage(ws, raw.toString(), state));
      ws.on('close', () => this.handleClose(ws, state));
      ws.on('error', (err) => {
        logger.error(`[${requestId}] WebSocket error:`, err);
        this.handleClose(ws, state);
      });

      logger.debug(`[${requestId}] WebSocket connection established, awaiting auth message`);
    });
    logger.info('ActivityFeed WebSocket server attached');
  }

  private generateRequestId(): string {
    return `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private verifyToken(token: string): boolean {
    try {
      jwt.verify(token, JWT_SECRET);
      return true;
    } catch (err) {
      logger.debug(`Token verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private handleMessage(ws: WebSocket, raw: string, state: ConnectionState): void {
    const { requestId } = state;

    // Parse incoming message
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      logger.warn(`[${requestId}] Failed to parse message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const incomingMsg = msg as IncomingMsg;

    // UNAUTHENTICATED: Only accept 'auth' type
    if (!state.authenticated) {
      if (incomingMsg.type === 'auth') {
        const authMsg = incomingMsg as AuthMsg;
        if (!authMsg.token || typeof authMsg.token !== 'string') {
          logger.warn(`[${requestId}] Auth message missing or invalid token field`);
          ws.close(4002, 'Invalid auth message format');
          this.removeSocket(ws);
          return;
        }

        if (!this.verifyToken(authMsg.token)) {
          logger.warn(`[${requestId}] Authentication failed: invalid token`);
          ws.close(4001, 'Authentication failed');
          this.removeSocket(ws);
          return;
        }

        // Mark as authenticated and cancel timeout
        state.authenticated = true;
        if (state.authTimer) {
          clearTimeout(state.authTimer);
          state.authTimer = undefined;
        }
        logger.info(`[${requestId}] WebSocket connection authenticated`);
        return;
      } else {
        // Non-auth message before authentication
        logger.warn(`[${requestId}] Received ${incomingMsg.type} before authentication`);
        ws.close(4001, 'Authentication required');
        this.removeSocket(ws);
        return;
      }
    }

    // AUTHENTICATED: Handle subscription messages
    if (incomingMsg.type === 'subscribe_activity') {
      const subscribeMsg = incomingMsg as SubscribeMsg;
      if (typeof subscribeMsg.marketId !== 'string') {
        logger.warn(`[${requestId}] Subscribe message missing or invalid marketId`);
        return;
      }

      if (!this.subscriptions.has(subscribeMsg.marketId)) {
        this.subscriptions.set(subscribeMsg.marketId, new Set());
      }
      this.subscriptions.get(subscribeMsg.marketId)!.add(ws);
      logger.debug(`[${requestId}] Subscribed to market ${subscribeMsg.marketId}`);
      return;
    }

    // Unknown message type after authentication
    logger.warn(`[${requestId}] Received unknown message type: ${incomingMsg.type}`);
  }

  private handleClose(ws: WebSocket, state: ConnectionState): void {
    const { requestId, authTimer } = state;
    
    // Clear auth timer if still pending
    if (authTimer) {
      clearTimeout(authTimer);
    }

    logger.debug(`[${requestId}] WebSocket connection closed`);
    this.removeSocket(ws);
  }

  private removeSocket(ws: WebSocket): void {
    for (const [marketId, sockets] of this.subscriptions.entries()) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.subscriptions.delete(marketId);
      }
    }
  }

  /** Publish an activity event to all subscribers of the market. */
  publish(event: ActivityEvent): void {
    const { marketId } = event as { marketId: string };
    if (!this.rateLimiter.allow(marketId)) return;

    const sockets = this.subscriptions.get(marketId);
    if (!sockets?.size) return;

    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
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
