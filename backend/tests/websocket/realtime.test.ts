import { Server } from 'http';
import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { ActivityFeed, ActivityEvent } from '../../src/websocket/realtime';

// Mock logger
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

const JWT_SECRET = 'test-jwt-secret';
process.env.JWT_SECRET = JWT_SECRET;

describe('ActivityFeed WebSocket Authentication', () => {
  let server: Server;
  let activityFeed: ActivityFeed;

  beforeEach(() => {
    // Create a simple HTTP server for WebSocket
    server = require('http').createServer();
    activityFeed = new ActivityFeed(server);
    server.listen(0); // Use random port
  });

  afterEach(() => {
    activityFeed.close();
    server.close();
  });

  describe('First-message authentication', () => {
    it('should require auth message within 5 seconds', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const wsUrl = `ws://localhost:${address.port}`;

      const ws = new WebSocket(wsUrl);
      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Wait for auth timeout (5 seconds)
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      const result = await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 6000)),
      ]);

      expect(result.code).toBe(4001);
      expect(result.reason).toContain('timeout');
    });

    it('should accept valid auth token in first message', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const wsUrl = `ws://localhost:${address.port}`;

      const token = jwt.sign({ userId: 'test-user' }, JWT_SECRET);
      const ws = new WebSocket(wsUrl);

      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Send auth message
      ws.send(JSON.stringify({ type: 'auth', token }));

      // Wait briefly and verify connection is still open
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    });

    it('should reject invalid token in auth message', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const wsUrl = `ws://localhost:${address.port}`;

      const ws = new WebSocket(wsUrl);
      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Send auth with invalid token
      ws.send(JSON.stringify({ type: 'auth', token: 'invalid-token' }));

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      const result = await closed;
      expect(result.code).toBe(4001);
      expect(result.reason).toContain('Authentication');
    });

    it('should reject non-auth message before authentication', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const wsUrl = `ws://localhost:${address.port}`;

      const ws = new WebSocket(wsUrl);
      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Send subscribe message before auth
      ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-123' }));

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      const result = await closed;
      expect(result.code).toBe(4001);
      expect(result.reason).toContain('Authentication required');
    });

    it('should reject malformed auth message (missing token field)', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const wsUrl = `ws://localhost:${address.port}`;

      const ws = new WebSocket(wsUrl);
      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Send auth message without token
      ws.send(JSON.stringify({ type: 'auth' }));

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      const result = await closed;
      expect(result.code).toBe(4002);
      expect(result.reason).toContain('Invalid');
    });

    it('should allow subscriptions after successful auth', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const wsUrl = `ws://localhost:${address.port}`;

      const token = jwt.sign({ userId: 'test-user' }, JWT_SECRET);
      const ws = new WebSocket(wsUrl);

      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Send auth
      ws.send(JSON.stringify({ type: 'auth', token }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send subscribe message
      const parseError = jest.fn();
      ws.on('error', parseError);

      ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-123' }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Connection should still be open
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(parseError).not.toHaveBeenCalled();

      ws.close();
    });
  });

  describe('No URL query parameters for JWT', () => {
    it('should not accept JWT from query parameters', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const token = jwt.sign({ userId: 'test-user' }, JWT_SECRET);
      const wsUrl = `ws://localhost:${address.port}?token=${token}`;

      const ws = new WebSocket(wsUrl);
      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Wait for auth timeout because query param is ignored
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      const result = await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 6000)),
      ]);

      expect(result.code).toBe(4001);
    });
  });

  describe('Activity publishing', () => {
    it('should deliver published events to authenticated subscribers', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const wsUrl = `ws://localhost:${address.port}`;

      const token = jwt.sign({ userId: 'test-user' }, JWT_SECRET);
      const ws = new WebSocket(wsUrl);

      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Authenticate
      ws.send(JSON.stringify({ type: 'auth', token }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Subscribe
      ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-123' }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Publish event
      const event: ActivityEvent = {
        type: 'trade',
        marketId: 'market-123',
        outcomeId: 'outcome-a',
        side: 'long',
        sharesAmount: 100,
        priceBps: 5000,
        timestamp: new Date().toISOString(),
      };

      const messagePromise = new Promise<ActivityEvent>((resolve) => {
        ws.once('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
      });

      activityFeed.publish(event);

      const received = await Promise.race([
        messagePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('No message received')), 1000)),
      ]);

      expect(received).toEqual(event);
      ws.close();
    });
  });

  describe('Connection cleanup', () => {
    it('should clean up auth timer on successful authentication', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const wsUrl = `ws://localhost:${address.port}`;

      const token = jwt.sign({ userId: 'test-user' }, JWT_SECRET);
      const ws = new WebSocket(wsUrl);

      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Send auth
      ws.send(JSON.stringify({ type: 'auth', token }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Wait longer than auth timeout to verify timer was cleared
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Connection should still be open
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    });

    it('should clean up subscriptions on connection close', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Invalid address');
      const wsUrl = `ws://localhost:${address.port}`;

      const token = jwt.sign({ userId: 'test-user' }, JWT_SECRET);
      const ws = new WebSocket(wsUrl);

      const connected = new Promise<void>((resolve) => {
        ws.once('open', () => resolve());
      });
      await connected;

      // Authenticate and subscribe
      ws.send(JSON.stringify({ type: 'auth', token }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-999' }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Close connection
      const closed = new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });

      ws.close();
      await closed;

      // Try to publish event — should not crash or send to anyone
      const event: ActivityEvent = {
        type: 'trade',
        marketId: 'market-999',
        outcomeId: 'outcome-a',
        side: 'long',
        sharesAmount: 100,
        priceBps: 5000,
        timestamp: new Date().toISOString(),
      };

      // This should not throw
      expect(() => activityFeed.publish(event)).not.toThrow();
    });
  });
});
