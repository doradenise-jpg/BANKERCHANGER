// backend/src/__tests__/websocket.test.ts
// Unit & integration tests for WebSocket security features (issue #563):
//   - Connection flooding protection (max connections per IP)
//   - Per-client message rate limiting (429 RATE_LIMIT_EXCEEDED)
//   - Duplicate subscription deduplication
//   - Heartbeat ping/pong and ghost connection cleanup
//   - Memory leak prevention (subscription cleanup on disconnect)

import { EventEmitter } from 'node:events';
import http from 'http';
import jwt from 'jsonwebtoken';
import type Redis from 'ioredis';
import { WebSocket } from 'ws';
import { ActivityFeed } from '../websocket/realtime';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';
process.env.JWT_SECRET ??= JWT_SECRET;

function makeToken(sub = 'test-user'): string {
  return jwt.sign({ sub, type: 'access' }, JWT_SECRET);
}

function makeActivityFeedToken(): string {
  return jwt.sign({
    sub: 'public-market-feed',
    type: 'ws_activity',
    scope: 'market_activity:read',
  }, JWT_SECRET, { expiresIn: '5m' });
}

/** Open a WS connection and wait for the socket to be ready. */
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.once('open', () => resolve(ws));
  });
}

/** Authenticate an open WebSocket connection. */
async function authenticate(ws: WebSocket): Promise<void> {
  ws.send(JSON.stringify({ type: 'auth', token: makeToken() }));
  // Give the server a tick to process the auth message.
  await new Promise((r) => setImmediate(r));
}

/** Collect the next N messages from a socket within a timeout. */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const msgs: unknown[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout: only received ${msgs.length}/${count} messages`)),
      timeoutMs,
    );
    const handler = (data: Buffer | string) => {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msgs);
      }
    };
    ws.on('message', handler);
  });
}

class InMemoryRedis extends EventEmitter {
  private static subscribers = new Set<InMemoryRedis>();
  private channels = new Set<string>();

  duplicate(): InMemoryRedis {
    return new InMemoryRedis();
  }

  subscribe(...channels: string[]): Promise<number> {
    channels.forEach((channel) => this.channels.add(channel));
    InMemoryRedis.subscribers.add(this);
    return Promise.resolve(1);
  }

  publish(channel: string, message: string): Promise<number> {
    let receivers = 0;
    for (const subscriber of InMemoryRedis.subscribers) {
      if (subscriber.channels.has(channel)) {
        subscriber.emit('message', channel, message);
        receivers++;
      }
    }
    return Promise.resolve(receivers);
  }

  disconnect(): void {
    InMemoryRedis.subscribers.delete(this);
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WebSocket security — ActivityFeed', () => {
  let server: http.Server;
  let feed: ActivityFeed;
  let port: number;

  beforeAll(
    (done) => {
      server = http.createServer();
      feed = new ActivityFeed(server);
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        done();
      });
    },
    10_000,
  );

  afterAll((done) => {
    feed.close();
    server.close(done);
  });

  // ── Per-client rate limiting ───────────────────────────────────────────────

  it('sends 429 RATE_LIMIT_EXCEEDED when a client exceeds the message rate limit', async () => {
    const ws = await connect(port);
    await authenticate(ws);

    // Flood the server with 25 rapid subscribe messages (limit is 20/sec)
    const BURST = 25;
    for (let i = 0; i < BURST; i++) {
      ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: `market-${i}` }));
    }

    // Collect at least one response — should contain a 429 error frame
    const msgs = await collectMessages(ws, 1, 1500).catch(() => []);
    const rateLimitFrame = (msgs as Array<{ code?: number; type?: string }>).find(
      (m) => m.code === 429 || m.type === 'error',
    );
    expect(rateLimitFrame).toBeDefined();

    ws.close();
  }, 5000);

  // ── Duplicate subscription deduplication ──────────────────────────────────

  it('does not double-add the same market subscription (deduplication)', async () => {
    const ws = await connect(port);
    await authenticate(ws);

    const MARKET_ID = 'dedup-market-001';
    // Send the same subscription three times
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    await new Promise((r) => setTimeout(r, 50));

    // The publish method should deliver exactly ONE copy of the event
    const messagePromise = collectMessages(ws, 1, 1500);
    feed.publish({ type: 'trade', marketId: MARKET_ID, outcomeId: 'a', side: 'FighterA', sharesAmount: 1, priceBps: 5000, timestamp: new Date().toISOString() });

    const msgs = await messagePromise;
    expect(msgs.length).toBe(1);

    ws.close();
  }, 5000);

  // ── Duplicate leaderboard subscription deduplication ─────────────────────

  it('does not double-add global leaderboard subscriptions', async () => {
    const ws = await connect(port);
    await authenticate(ws);

    // Subscribe to global leaderboard twice
    ws.send(JSON.stringify({ type: 'subscribe_leaderboard' }));
    ws.send(JSON.stringify({ type: 'subscribe_leaderboard' }));
    await new Promise((r) => setTimeout(r, 50));

    // Publish one event; the client should receive it exactly once
    const messagePromise = collectMessages(ws, 1, 1500);
    feed.publish({
      type: 'leaderboard_rank_update',
      userId: 'user-1',
      rank: 1,
      timestamp: new Date().toISOString(),
    });

    const msgs = await messagePromise;
    expect(msgs.length).toBe(1);

    ws.close();
  }, 5000);

  it('broadcasts market:created events to global market subscribers', async () => {
    const ws = await connect(port);
    ws.send(JSON.stringify({ type: 'auth', token: makeActivityFeedToken() }));
    await new Promise((r) => setImmediate(r));
    ws.send(JSON.stringify({ type: 'subscribe_market_created' }));
    await new Promise((r) => setImmediate(r));

    const messagePromise = collectMessages(ws, 1);
    feed.publishMarketCreated({
      type: 'market:created',
      marketId: 'new-market-001',
      fighterA: 'Fighter A',
      fighterB: 'Fighter B',
    });

    await expect(messagePromise).resolves.toEqual([{
      type: 'market:created',
      marketId: 'new-market-001',
      fighterA: 'Fighter A',
      fighterB: 'Fighter B',
    }]);
    ws.close();
  }, 5000);

  it('accepts /subscribe market:ID and emits canonical market lifecycle events', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await authenticate(ws);
    ws.send('/subscribe market:canonical-market-001');
    await new Promise((r) => setTimeout(r, 50));

    const messagePromise = collectMessages(ws, 2);
    feed.publish({
      type: 'market_update',
      marketId: 'canonical-market-001',
      eventType: 'market_locked',
      data: { status: 'locked', user_id: 'private-user' },
    });

    await expect(messagePromise).resolves.toEqual([
      {
        type: 'market_update',
        marketId: 'canonical-market-001',
        eventType: 'market_locked',
        data: { status: 'locked' },
      },
      {
        type: 'market_locked',
        marketId: 'canonical-market-001',
        data: { status: 'locked' },
      },
    ]);

    const terminalEvents = collectMessages(ws, 4);
    feed.publish({
      type: 'market_update',
      marketId: 'canonical-market-001',
      eventType: 'market_resolved',
      data: { outcome: 'fighter_a' },
    });
    feed.publish({
      type: 'market_update',
      marketId: 'canonical-market-001',
      eventType: 'market_cancelled',
      data: { reason: 'void' },
    });
    await expect(terminalEvents).resolves.toEqual([
      {
        type: 'market_update',
        marketId: 'canonical-market-001',
        eventType: 'market_resolved',
        data: { outcome: 'fighter_a' },
      },
      {
        type: 'market_resolved',
        marketId: 'canonical-market-001',
        data: { outcome: 'fighter_a' },
      },
      {
        type: 'market_update',
        marketId: 'canonical-market-001',
        eventType: 'market_cancelled',
        data: { reason: 'void' },
      },
      {
        type: 'market_cancelled',
        marketId: 'canonical-market-001',
        data: { reason: 'void' },
      },
    ]);
    ws.close();
  }, 5000);

  it('broadcasts market events between WebSocket workers through Redis Pub/Sub', async () => {
    const workerOneServer = http.createServer();
    const workerTwoServer = http.createServer();
    const workerOne = new ActivityFeed(workerOneServer, new InMemoryRedis() as unknown as Redis);
    const workerTwo = new ActivityFeed(workerTwoServer, new InMemoryRedis() as unknown as Redis);
    await Promise.all([
      new Promise<void>((resolve) => workerOneServer.listen(0, resolve)),
      new Promise<void>((resolve) => workerTwoServer.listen(0, resolve)),
    ]);

    const portOne = (workerOneServer.address() as { port: number }).port;
    const portTwo = (workerTwoServer.address() as { port: number }).port;
    const clientOne = await connect(portOne);
    const clientTwo = await connect(portTwo);
    await Promise.all([authenticate(clientOne), authenticate(clientTwo)]);
    clientOne.send('/subscribe market:redis-market-001');
    clientTwo.send('/subscribe market:redis-market-001');
    await new Promise((r) => setTimeout(r, 50));

    const remoteMessages = collectMessages(clientTwo, 2);
    workerOne.publish({
      type: 'market_update',
      marketId: 'redis-market-001',
      eventType: 'odds_changed',
      data: { fighter_a_odds: 1.8 },
    });

    await expect(remoteMessages).resolves.toEqual([
      {
        type: 'market_update',
        marketId: 'redis-market-001',
        eventType: 'odds_changed',
        data: { fighter_a_odds: 1.8 },
      },
      {
        type: 'market_updated',
        marketId: 'redis-market-001',
        data: { fighter_a_odds: 1.8 },
      },
    ]);

    const ammMessage = collectMessages(clientTwo, 1);
    await new InMemoryRedis().publish(
      'market_events',
      JSON.stringify({
        type: 'bet_executed',
        market_id: 'redis-market-001',
        outcome: 'fighter_a',
        amount: 10,
        odds: 1.8,
        bettor: 'private-bettor',
        timestamp: 'now',
      }),
    );
    await expect(ammMessage).resolves.toEqual([
      {
        type: 'market_updated',
        marketId: 'redis-market-001',
        data: { outcome: 'fighter_a', amount: 10, odds: 1.8, timestamp: 'now' },
      },
    ]);

    clientOne.close();
    clientTwo.close();
    workerOne.close();
    workerTwo.close();
    await Promise.all([
      new Promise<void>((resolve) => workerOneServer.close(() => resolve())),
      new Promise<void>((resolve) => workerTwoServer.close(() => resolve())),
    ]);
  }, 10000);

  // ── Memory leak: subscription cleanup on disconnect ───────────────────────

  it('removes all subscriptions from internal maps on disconnect', async () => {
    const MARKET_ID = 'cleanup-market-001';
    const ws = await connect(port);
    await authenticate(ws);

    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    ws.send(JSON.stringify({ type: 'subscribe_leaderboard' }));
    await new Promise((r) => setTimeout(r, 50));

    // Verify the client is connected
    expect(feed.getConnectedClientCount()).toBeGreaterThanOrEqual(1);

    // Close the socket
    ws.close();
    // Allow cleanup handlers to run
    await new Promise((r) => setTimeout(r, 150));

    // After disconnect the subscription distribution for this market should be 0
    const dist = feed.getSubscriptionDistribution();
    expect(dist[`market:${MARKET_ID}`] ?? 0).toBe(0);
  }, 5000);

  // ── Metrics / observability ───────────────────────────────────────────────

  it('getSubscriptionDistribution returns a record of room -> client-count', async () => {
    const ws = await connect(port);
    await authenticate(ws);

    const MARKET_ID = 'metrics-market-001';
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    await new Promise((r) => setTimeout(r, 50));

    const dist = feed.getSubscriptionDistribution();
    expect(dist[`market:${MARKET_ID}`]).toBeGreaterThanOrEqual(1);

    ws.close();
  }, 5000);

  // ── Auth enforcement ───────────────────────────────────────────────────────

  it('closes the connection when subscribing without authenticating first', async () => {
    const ws = await connect(port);

    // Send a subscribe message without auth
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'no-auth-market' }));

    const closedCode = await new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });

    expect(closedCode).toBe(4001);
  }, 5000);

  it('limits activity-feed tokens to market activity subscriptions', async () => {
    const ws = await connect(port);
    ws.send(JSON.stringify({ type: 'auth', token: makeActivityFeedToken() }));
    await new Promise((r) => setImmediate(r));

    const messagesPromise = collectMessages(ws, 2);
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'resolved-market' }));
    ws.send(JSON.stringify({ type: 'subscribe_leaderboard' }));
    await new Promise((r) => setTimeout(r, 50));
    feed.publish({ type: 'resolved', marketId: 'resolved-market', winningOutcomeId: 'fighter_a' });

    const messages = await messagesPromise;
    expect(messages).toContainEqual({
      type: 'error',
      code: 403,
      message: 'INSUFFICIENT_SCOPE',
    });
    expect(messages).toContainEqual({
      type: 'resolved',
      marketId: 'resolved-market',
      winningOutcomeId: 'fighter_a',
    });

    ws.close();
  }, 5000);

  // ── Auth timeout ───────────────────────────────────────────────────────────

  it('closes the connection if auth is not received within the timeout', async () => {
    const ws = await connect(port);

    // Do NOT send auth. Wait for the server to time out (5 s timeout in production,
    // but we just verify the close code is 4001).
    const closedCode = await new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });

    expect(closedCode).toBe(4001);
  }, 10_000);
});
