import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';

let wss: WebSocketServer | null = null;

export interface StreamMessage {
  type: string;
  timestamp: string;
  data: unknown;
}

/**
 * Attach a WebSocket server to the existing HTTP server so clients can
 * subscribe to indexed events in real time instead of polling the REST API.
 */
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
    // wss.close() alone doesn't terminate already-open client sockets, which
    // would otherwise keep the underlying HTTP server (and the process) alive.
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
    wss = null;
  }
}
