/**
 * Tests for issue #659 — WebSocket server leaks user data across rooms
 *
 * Verifies that all market-room WebSocket broadcast payloads are passed through
 * the DTO whitelist projection so that private fields (user_id, wallet_address,
 * etc.) are never sent to subscribers.
 */

import http from 'http';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { ActivityFeed } from '../../src/websocket/realtime';
import { toMarketEventDTO } from '../../src/dto/market.dto';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';

// ── JWT helpers ───────────────────────────────────────────────────────────────

function makeToken(sub = 'test-user'): string {
  return jwt.sign({ sub, type: 'access' }, JWT_SECRET);
}

// ── Connection helpers ────────────────────────────────────────────────────────

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.once('open', () => resolve(ws));
  });
}

async function authenticate(ws: WebSocket): Promise<void> {
  ws.send(JSON.stringify({ type: 'auth', token: makeToken() }));
  await new Promise((r) => setImmediate(r));
}

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

// ── Unit tests for toMarketEventDTO ──────────────────────────────────────────

describe('toMarketEventDTO — whitelist projection (unit)', () => {
  it('strips user_id from a trade event if accidentally present', () => {
    const event = {
      type: 'trade' as const,
      marketId: 'mkt-1',
      outcomeId: 'a',
      side: 'FighterA',
      sharesAmount: 10,
      priceBps: 5000,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const dto = toMarketEventDTO(event) as Record<string, unknown>;
    expect(dto).not.toHaveProperty('user_id');
    expect(dto).not.toHaveProperty('wallet_address');
    expect(dto.type).toBe('trade');
    expect(dto.marketId).toBe('mkt-1');
  });

  it('only includes whitelisted fields for trade events', () => {
    const event = {
      type: 'trade' as const,
      marketId: 'mkt-1',
      outcomeId: 'a',
      side: 'FighterA',
      sharesAmount: 10,
      priceBps: 5000,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const dto = toMarketEventDTO(event);
    const keys = Object.keys(dto);
    expect(keys).toEqual(['type', 'marketId', 'outcomeId', 'side', 'sharesAmount', 'priceBps', 'timestamp']);
  });

  it('strips user_id and wallet_address from market_update data payload', () => {
    const event = {
      type: 'market_update' as const,
      marketId: 'mkt-1',
      eventType: 'status_changed',
      data: {
        status: 'locked',
        user_id: 'user-secret-123',
        wallet_address: 'GXXXSECRETWALLETADDRESS',
        publicInfo: 'visible',
      },
    };
    const dto = toMarketEventDTO(event) as { type: string; data: Record<string, unknown> };
    expect(dto.data).not.toHaveProperty('user_id');
    expect(dto.data).not.toHaveProperty('wallet_address');
    expect(dto.data.status).toBe('locked');
    expect(dto.data.publicInfo).toBe('visible');
  });

  it('only includes whitelisted fields for dispute events', () => {
    const event = {
      type: 'dispute' as const,
      marketId: 'mkt-2',
      proposedOutcomeId: 'fighter_a',
    };
    const dto = toMarketEventDTO(event);
    expect(dto).toEqual({ type: 'dispute', marketId: 'mkt-2', proposedOutcomeId: 'fighter_a' });
  });

  it('only includes whitelisted fields for resolved events', () => {
    const event = {
      type: 'resolved' as const,
      marketId: 'mkt-3',
      winningOutcomeId: 'fighter_b',
    };
    const dto = toMarketEventDTO(event);
    expect(dto).toEqual({ type: 'resolved', marketId: 'mkt-3', winningOutcomeId: 'fighter_b' });
  });

  it('only includes whitelisted fields for cancelled events', () => {
    const event = { type: 'cancelled' as const, marketId: 'mkt-4' };
    const dto = toMarketEventDTO(event);
    expect(dto).toEqual({ type: 'cancelled', marketId: 'mkt-4' });
  });
});

// ── Integration tests — subscribe to market room, check broadcast payload ────

describe('WebSocket broadcast — DTO projection prevents private field leakage (integration)', () => {
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
  }, 10_000);

  afterAll((done) => {
    feed.close();
    server.close(done);
  });

  it('trade broadcast does not include user_id or wallet_address', async () => {
    const ws = await connect(port);
    await authenticate(ws);

    const MARKET_ID = 'dto-test-market-001';
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    await new Promise((r) => setTimeout(r, 50));

    const messagePromise = collectMessages(ws, 1, 2000);

    feed.publish({
      type: 'trade',
      marketId: MARKET_ID,
      outcomeId: 'a',
      side: 'FighterA',
      sharesAmount: 100,
      priceBps: 5000,
      timestamp: new Date().toISOString(),
    });

    const [msg] = await messagePromise as Array<Record<string, unknown>>;
    expect(msg).not.toHaveProperty('user_id');
    expect(msg).not.toHaveProperty('wallet_address');
    expect(msg.type).toBe('trade');
    expect(msg.marketId).toBe(MARKET_ID);

    ws.close();
  }, 5000);

  it('market_update broadcast strips private fields from data payload', async () => {
    const ws = await connect(port);
    await authenticate(ws);

    const MARKET_ID = 'dto-test-market-002';
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    await new Promise((r) => setTimeout(r, 50));

    const messagePromise = collectMessages(ws, 1, 2000);

    feed.publish({
      type: 'market_update',
      marketId: MARKET_ID,
      eventType: 'status_changed',
      data: {
        status: 'locked',
        user_id: 'internal-user-id',
        wallet_address: 'GSECRETWALLETADDRESS',
        public_field: 'visible',
      },
    });

    const [msg] = await messagePromise as Array<Record<string, unknown>>;
    const data = msg.data as Record<string, unknown>;

    expect(msg.type).toBe('market_update');
    expect(data).not.toHaveProperty('user_id');
    expect(data).not.toHaveProperty('wallet_address');
    expect(data.status).toBe('locked');
    expect(data.public_field).toBe('visible');

    ws.close();
  }, 5000);

  it('broadcast payload schema matches the public MarketActivityEventDTO shape', async () => {
    const ws = await connect(port);
    await authenticate(ws);

    const MARKET_ID = 'dto-test-market-003';
    ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    await new Promise((r) => setTimeout(r, 50));

    const messagePromise = collectMessages(ws, 1, 2000);

    const sentEvent = {
      type: 'trade' as const,
      marketId: MARKET_ID,
      outcomeId: 'b',
      side: 'FighterB',
      sharesAmount: 50,
      priceBps: 4800,
      timestamp: new Date().toISOString(),
    };
    feed.publish(sentEvent);

    const [msg] = await messagePromise as Array<Record<string, unknown>>;

    // Exact shape must match the public TradeEventDTO whitelist
    expect(msg).toEqual({
      type: 'trade',
      marketId: MARKET_ID,
      outcomeId: 'b',
      side: 'FighterB',
      sharesAmount: 50,
      priceBps: 4800,
      timestamp: sentEvent.timestamp,
    });

    ws.close();
  }, 5000);
});
