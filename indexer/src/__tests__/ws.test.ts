import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer } from 'http';
import WebSocket from 'ws';
import {
  initWebSocketServer,
  broadcast,
  getConnectedClientCount,
  closeWebSocketServer,
} from '../ws';

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('WebSocket event stream', () => {
  let httpServer: ReturnType<typeof createServer> | undefined;

  afterEach((done) => {
    closeWebSocketServer();
    if (httpServer) {
      httpServer.close(() => done());
      httpServer = undefined;
    } else {
      done();
    }
  });

  it('sends a connected message on connect and reports client count', async () => {
    httpServer = createServer();
    initWebSocketServer(httpServer);
    const port = await listen(httpServer);

    expect(getConnectedClientCount()).toBe(0);

    const client = new WebSocket(`ws://localhost:${port}/ws`);
    const firstMessage = await new Promise<any>((resolve) => {
      client.on('message', (data) => resolve(JSON.parse(data.toString())));
    });

    expect(firstMessage.type).toBe('connected');
    expect(getConnectedClientCount()).toBe(1);

    client.terminate();
  });

  it('broadcasts ingested-event messages to all connected clients', async () => {
    httpServer = createServer();
    initWebSocketServer(httpServer);
    const port = await listen(httpServer);

    const messages: any[] = [];
    const client = new WebSocket(`ws://localhost:${port}/ws`);
    client.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => client.once('open', resolve));

    // Wait for the initial "connected" message before broadcasting, so the
    // assertion below only sees the message under test.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (messages.length >= 1) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    broadcast({ type: 'invoice.funded', timestamp: new Date().toISOString(), data: { invoiceId: 'INV-1' } });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (messages.length >= 2) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    expect(messages[1].type).toBe('invoice.funded');
    expect(messages[1].data.invoiceId).toBe('INV-1');

    client.terminate();
  });

  it('is a no-op when no server has been initialized', () => {
    expect(() =>
      broadcast({ type: 'invoice.paid', timestamp: new Date().toISOString(), data: {} })
    ).not.toThrow();
    expect(getConnectedClientCount()).toBe(0);
  });
});
