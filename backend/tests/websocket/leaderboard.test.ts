// tests/websocket/leaderboard.test.ts
// Integration: engagement rank change -> subscribed WS client receives update.

import http from 'http';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { ActivityFeed, type LeaderboardRankEvent } from '../../src/websocket/realtime';
import { engagementService } from '../../src/services/engagement.service';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';

function token(): string {
  return jwt.sign({ sub: 'test-user', type: 'access' }, JWT_SECRET);
}

function nextMessage(ws: WebSocket, timeoutMs = 1000): Promise<LeaderboardRankEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for WS message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as LeaderboardRankEvent);
    });
  });
}

describe('leaderboard rank updates over WebSocket', () => {
  let server: http.Server;
  let feed: ActivityFeed;
  let port: number;

  beforeAll((done) => {
    server = http.createServer();
    feed = new ActivityFeed(server);
    engagementService.__reset();
    engagementService.setRankUpdateListener((updates) => feed.emitLeaderboardRankUpdate(updates));
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  afterAll((done) => {
    engagementService.__reset();
    feed.close();
    server.close(done);
  });

  it('delivers a leaderboard_rank_update to a subscribed client', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.once('open', resolve));

    ws.send(JSON.stringify({ type: 'auth', token: token() }));
    await new Promise((r) => setImmediate(r));

    ws.send(JSON.stringify({ type: 'subscribe_leaderboard' }));
    await new Promise((r) => setImmediate(r));

    const received = nextMessage(ws);
    engagementService.addPoints('alice', 120);
    const event = await received;

    expect(event.type).toBe('leaderboard_rank_update');
    expect(event.updates.some((u) => u.userId === 'alice' && u.newRank === 1)).toBe(true);
    expect(typeof event.timestamp).toBe('string');

    ws.close();
  });

  it('does not deliver updates after unsubscribe', async () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'auth', token: token() }));
    await new Promise((r) => setImmediate(r));
    ws.send(JSON.stringify({ type: 'subscribe_leaderboard' }));
    await new Promise((r) => setImmediate(r));
    ws.send(JSON.stringify({ type: 'unsubscribe_leaderboard' }));
    await new Promise((r) => setImmediate(r));

    let got = false;
    ws.once('message', () => {
      got = true;
    });
    engagementService.addPoints('bob', 999);
    await new Promise((r) => setTimeout(r, 100));

    expect(got).toBe(false);
    ws.close();
  });
});
