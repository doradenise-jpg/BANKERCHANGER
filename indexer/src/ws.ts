import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import { logger } from './logger';

let wss: WebSocketServer | null = null;

export interface StreamMessage {
  type: string;
  timestamp: string;
  data: unknown;
}

// ── Metrics (#692) ────────────────────────────────────────────────────────────

export const wsMetrics = {
  indexer_ws_reconnects_total: 0,
};

// ── WebSocket Client Manager for Upstream Feeds & Room Resubscription (#692) ──

export interface WsClientOptions {
  url: string;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export class ResilientWsClient {
  private url: string;
  private minDelay: number;
  private maxDelay: number;
  private currentDelay: number;
  private ws: WebSocket | null = null;
  private activeSubscriptions: Set<string> = new Set();
  private isClosedExplicitly: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: WsClientOptions) {
    this.url = options.url;
    this.minDelay = options.minReconnectDelayMs ?? 1000;
    this.maxDelay = options.maxReconnectDelayMs ?? 60000;
    this.currentDelay = this.minDelay;
  }

  public getActiveSubscriptions(): string[] {
    return Array.from(this.activeSubscriptions);
  }

  public subscribe(roomOrStream: string): void {
    this.activeSubscriptions.add(roomOrStream);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(roomOrStream);
    }
  }

  public unsubscribe(roomOrStream: string): void {
    this.activeSubscriptions.delete(roomOrStream);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', room: roomOrStream }));
    }
  }

  private sendSubscription(roomOrStream: string): void {
    try {
      this.ws?.send(JSON.stringify({ type: 'subscribe', room: roomOrStream }));
    } catch (err) {
      logger.error({ err, room: roomOrStream }, 'Failed to send subscription');
    }
  }

  public connect(): void {
    this.isClosedExplicitly = false;
    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        logger.info({ url: this.url }, 'Connected to upstream WebSocket feed');
        this.currentDelay = this.minDelay;

        // Re-subscribe to all active rooms immediately upon reconnect
        for (const room of this.activeSubscriptions) {
          this.sendSubscription(room);
        }
      });

      this.ws.on('close', () => {
        if (!this.isClosedExplicitly) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        logger.warn({ err: err.message }, 'WebSocket client connection error');
      });
    } catch (err: any) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    wsMetrics.indexer_ws_reconnects_total++;

    logger.info(
      {
        delayMs: this.currentDelay,
        metric: 'indexer_ws_reconnects_total',
        value: wsMetrics.indexer_ws_reconnects_total,
      },
      `WebSocket disconnected; scheduling reconnect in ${this.currentDelay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.currentDelay);

    // Exponential backoff capped at maxDelay (min 1s, max 60s)
    this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);
  }

  public close(): void {
    this.isClosedExplicitly = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
  }
}

// ── WebSocket Server for Downstream Consumers ────────────────────────────────

export const MAX_SUBSCRIPTIONS_PER_CLIENT = 50;
export const MAX_MESSAGES_PER_SECOND_PER_IP = 20;
export const MARKET_ID_REGEX = /^(\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

const ipMessageTimestamps = new Map<string, number[]>();

export function checkIpRateLimit(ip: string, now: number = Date.now()): boolean {
  let timestamps = ipMessageTimestamps.get(ip);
  if (!timestamps) {
    timestamps = [];
    ipMessageTimestamps.set(ip, timestamps);
  }
  const cutoff = now - 1000;
  timestamps = timestamps.filter((t) => t > cutoff);
  if (timestamps.length >= MAX_MESSAGES_PER_SECOND_PER_IP) {
    ipMessageTimestamps.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  ipMessageTimestamps.set(ip, timestamps);
  return true;
}

export function resetIpRateLimits(): void {
  ipMessageTimestamps.clear();
}

export function handleClientMessage(
  socket: { send: (data: string) => void },
  raw: string | object,
  clientSubscriptions: Set<string>,
  ip: string = '127.0.0.1'
): boolean {
  if (!checkIpRateLimit(ip)) {
    socket.send(
      JSON.stringify({
        type: 'error',
        error: 'Rate limit exceeded: max 20 messages per second',
      })
    );
    return false;
  }

  const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (msg.type === 'subscribe' || msg.type === 'subscribe_market') {
    const marketId = msg.market_id || msg.marketId || msg.room;
    if (marketId) {
      if (!MARKET_ID_REGEX.test(String(marketId))) {
        socket.send(
          JSON.stringify({
            type: 'error',
            error: 'Invalid market_id format: must be numeric or UUID',
          })
        );
        return false;
      }
      if (
        clientSubscriptions.size >= MAX_SUBSCRIPTIONS_PER_CLIENT &&
        !clientSubscriptions.has(String(marketId))
      ) {
        socket.send(
          JSON.stringify({
            type: 'error',
            error: `Subscription limit reached: maximum ${MAX_SUBSCRIPTIONS_PER_CLIENT} active subscriptions permitted`,
          })
        );
        return false;
      }
      clientSubscriptions.add(String(marketId));
      socket.send(
        JSON.stringify({
          type: 'subscribed',
          market_id: marketId,
          active_subscriptions: clientSubscriptions.size,
        })
      );
      return true;
    }
  } else if (msg.type === 'unsubscribe' || msg.type === 'unsubscribe_market') {
    const marketId = msg.market_id || msg.marketId || msg.room;
    if (marketId) {
      clientSubscriptions.delete(String(marketId));
      socket.send(
        JSON.stringify({
          type: 'unsubscribed',
          market_id: marketId,
          active_subscriptions: clientSubscriptions.size,
        })
      );
      return true;
    }
  }
  return true;
}

export function initWebSocketServer(httpServer: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (socket: WebSocket, req: any) => {
    const ip =
      (req?.headers?.['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req?.socket?.remoteAddress ||
      '127.0.0.1';
    const clientSubscriptions = new Set<string>();

    socket.send(
      JSON.stringify({
        type: 'connected',
        timestamp: new Date().toISOString(),
        data: { message: 'subscribed to indexer event stream' },
      } satisfies StreamMessage)
    );

    socket.on('message', (raw: any) => {
      try {
        handleClientMessage(socket, raw.toString(), clientSubscriptions, ip);
      } catch {
        // Ignore unparseable frames
      }
    });
  });

  return wss;
}

/** Send a message to every currently connected WebSocket client. */
export function broadcast(message: StreamMessage): void {
  if (!wss) return;

  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function getConnectedClientCount(): number {
  return wss ? wss.clients.size : 0;
}

/** Test/shutdown helper to reset module state between runs. */
export function closeWebSocketServer(): void {
  if (wss) {
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
    wss = null;
  }
}
