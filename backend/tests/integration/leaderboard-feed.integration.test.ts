// tests/integration/leaderboard-feed.integration.test.ts
// Integration test: WebSocket leaderboard subscription + rank updates

import http from 'http';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { ActivityFeed, type ActivityEvent } from '../../src/websocket/realtime';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';

function generateTestToken(): string {
  return jwt.sign({ sub: 'test-user', type: 'access' }, JWT_SECRET);
}

function waitForMessage(ws: WebSocket, timeoutMs = 1000): Promise<ActivityEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for WS message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as ActivityEvent);
    });
  });
}

async function connectAndSubscribe(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'auth', token }));
  await new Promise((r) => setImmediate(r));
  ws.send(JSON.stringify({ type: 'subscribe_leaderboard' }));
  await new Promise((r) => setImmediate(r));
  return ws;
}

describe('LeaderboardFeed integration', () => {
  let server: http.Server;
  let feed: ActivityFeed;
  let port: number;

  beforeAll((done) => {
    server = http.createServer();
    feed = new ActivityFeed(server);
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  afterAll((done) => {
    feed.close();
    server.close(done);
  });

  it('delivers a leaderboard rank event to a subscribed client', async () => {
    const token = generateTestToken();
    const ws = await connectAndSubscribe(port, token);

    const rankEvent: ActivityEvent = {
      type: 'leaderboard_rank',
      marketId: 'leaderboard',
      address: 'GBXPZMXTK4WZHCXZASP7F3VW3JZOZXZ6V7ZRNBXKF6VPVDPF56IHTLFO',
      rank: 1,
      score: 42,
      timestamp: new Date().toISOString(),
    };

    feed.publish(rankEvent);

    const received = await waitForMessage(ws);
    expect(received).toEqual(rankEvent);

    ws.close();
  });

  it('does not deliver a leaderboard event to a market-activity only subscriber', async () => {
    const token = generateTestToken();
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'auth', token }));
    await new Promise((r) => setImmediate(r));
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-1' }));
    await new Promise((r) => setImmediate(r));

    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));

    feed.publish({
      type: 'leaderboard_rank',
      marketId: 'leaderboard',
      address: 'GBXPZMXTK4WZHCXZASP7F3VW3JZOZXZ6V7ZRNBXKF6VPVDPF56IHTLFO',
      rank: 2,
      score: 10,
      timestamp: '',
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(messages).toHaveLength(0);

    ws.close();
  });

  it('delivers a market trade event alongside a live leaderboard subscription', async () => {
    const token = generateTestToken();
    const ws = await connectAndSubscribe(port, token);

    const tradeEvent: ActivityEvent = {
      type: 'trade',
      marketId: 'market-lb',
      outcomeId: 'outcome-a',
      side: 'buy',
      sharesAmount: 10,
      priceBps: 5000,
      timestamp: new Date().toISOString(),
    };

    feed.publish(tradeEvent);

    const received = await waitForMessage(ws);
    expect(received).toEqual(tradeEvent);

    ws.close();
  });
});
