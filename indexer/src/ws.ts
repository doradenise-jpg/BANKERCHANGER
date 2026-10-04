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

export function initWebSocketServer(httpServer: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (socket: WebSocket) => {
    socket.send(
      JSON.stringify({
        type: 'connected',
        timestamp: new Date().toISOString(),
        data: { message: 'subscribed to indexer event stream' },
      } satisfies StreamMessage)
    );
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
