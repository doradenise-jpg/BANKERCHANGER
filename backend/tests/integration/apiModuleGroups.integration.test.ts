import { Router } from 'express';
import walletsRouter from '../../src/routes/wallets.routes';
import marketManagementRouter from '../../src/routes/marketManagement.routes';

// ---------------------------------------------------------------------------
// Integration tests for Endpoint Groups 19-20
// ---------------------------------------------------------------------------

// Mock dependencies
jest.mock('../../src/middleware/auth.middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'test-user-id', role: 'user' };
    next();
  },
}));

jest.mock('../../src/middleware/requireAdminJwt.middleware', () => ({
  requireAdminJwt: (req: any, _res: any, next: any) => {
    req.user = { id: 'admin-user-id', role: 'admin' };
    next();
  },
}));

jest.mock('../../src/config/db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    totalCount: 10,
    idleCount: 5,
    waitingCount: 0,
  },
}));

jest.mock('../../src/config/redis', () => ({
  redis: {
    ping: jest.fn().mockResolvedValue('PONG'),
  },
}));

jest.mock('../../src/services/cache.service', () => ({
  redis: { ping: jest.fn().mockResolvedValue('PONG'), ttl: jest.fn().mockResolvedValue(30) },
}));

jest.mock('../../src/services/redis-lua', () => ({
  incrWithExpire: jest.fn().mockResolvedValue(1),
}));

import request from 'supertest';
import { incrWithExpire } from '../../src/services/redis-lua';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const mockIncr = incrWithExpire as jest.Mock;

function createTestApp(router: Router) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/test', router);
  app.use(errorMiddleware);
  return app;
}

describe('Endpoint Group 19: Wallets & Payments', () => {
  const app = createTestApp(walletsRouter);

  it('GET /test - lists the authenticated user wallets', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /test - validates query parameters', async () => {
    const res = await request(app).get('/test?page=0&limit=500');
    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('errors');
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('GET /test/:walletId - returns wallet detail', async () => {
    const res = await request(app).get('/test/a1b2c3d4-0000-4000-8000-000000000001');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('balance');
  });

  it('GET /test/:walletId - rejects an invalid uuid', async () => {
    const res = await request(app).get('/test/not-a-uuid');
    expect(res.status).toBe(422);
  });

  it('GET /test/:walletId/transactions - returns transactions', async () => {
    const res = await request(app).get('/test/a1b2c3d4-0000-4000-8000-000000000001/transactions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
  });

  it('GET /test/:walletId/transactions - validates transaction type', async () => {
    const res = await request(app).get(
      '/test/a1b2c3d4-0000-4000-8000-000000000001/transactions?type=wired',
    );
    expect(res.status).toBe(422);
  });

  it('POST /test/deposit - initiates a deposit', async () => {
    const res = await request(app)
      .post('/test/deposit')
      .send({
        walletId: 'a1b2c3d4-0000-4000-8000-000000000001',
        currency: 'USD',
        amount: 250_000,
        paymentMethod: 'stellar',
      });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('depositId');
    expect(res.body.status).toBe('processing');
  });

  it('POST /test/deposit - rejects a non-positive amount', async () => {
    const res = await request(app)
      .post('/test/deposit')
      .send({
        walletId: 'a1b2c3d4-0000-4000-8000-000000000001',
        currency: 'USD',
        amount: -10,
        paymentMethod: 'card',
      });
    expect(res.status).toBe(422);
  });

  it('POST /test/withdraw - initiates a withdrawal', async () => {
    mockIncr.mockResolvedValueOnce(1);
    const res = await request(app)
      .post('/test/withdraw')
      .send({
        walletId: 'a1b2c3d4-0000-4000-8000-000000000001',
        currency: 'USD',
        amount: 100_000,
        destination: '0xRecipientAddress',
      });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('withdrawalId');
    expect(res.body.status).toBe('pending_review');
  });

  it('POST /test/withdraw - rejects a missing destination', async () => {
    mockIncr.mockResolvedValueOnce(1);
    const res = await request(app)
      .post('/test/withdraw')
      .send({
        walletId: 'a1b2c3d4-0000-4000-8000-000000000001',
        currency: 'USD',
        amount: 100_000,
      });
    expect(res.status).toBe(422);
  });

  it('POST /test/withdraw - enforces the withdrawal rate limit', async () => {
    mockIncr.mockResolvedValueOnce(6);
    const res = await request(app)
      .post('/test/withdraw')
      .send({
        walletId: 'a1b2c3d4-0000-4000-8000-000000000001',
        currency: 'USD',
        amount: 100_000,
        destination: '0xRecipientAddress',
      });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe('Too Many Requests');
  });
});

describe('Endpoint Group 20: Market Management & Escrow', () => {
  const app = createTestApp(marketManagementRouter);

  it('GET /test/markets - lists markets with filters', async () => {
    const res = await request(app).get('/test/markets?status=open&sport=boxing');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
  });

  it('GET /test/markets - validates the status enum', async () => {
    const res = await request(app).get('/test/markets?status=shady');
    expect(res.status).toBe(422);
  });

  it('GET /test/markets/:marketId - returns market detail', async () => {
    const res = await request(app).get('/test/markets/11111111-0000-4000-8000-000000000001');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('escrow');
  });

  it('POST /test/escrow/hold - places an escrow hold', async () => {
    mockIncr.mockResolvedValueOnce(1);
    const res = await request(app)
      .post('/test/escrow/hold')
      .send({
        marketId: '11111111-0000-4000-8000-000000000001',
        amountUsd: 5_000_000,
        holdRef: 'ESC-2026-0001',
      });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('holdId');
    expect(res.body.status).toBe('pending');
  });

  it('POST /test/escrow/hold - rejects without a holdRef', async () => {
    mockIncr.mockResolvedValueOnce(1);
    const res = await request(app)
      .post('/test/escrow/hold')
      .send({
        marketId: '11111111-0000-4000-8000-000000000001',
        amountUsd: 5_000_000,
      });
    expect(res.status).toBe(422);
  });

  it('POST /test/markets/:marketId/close - schedules a market close', async () => {
    mockIncr.mockResolvedValueOnce(1);
    const res = await request(app)
      .post('/test/markets/11111111-0000-4000-8000-000000000001/close')
      .send({ reason: 'regulatory' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('close_scheduled');
  });

  it('POST /test/markets/:marketId/close - rejects an invalid close reason', async () => {
    mockIncr.mockResolvedValueOnce(1);
    const res = await request(app)
      .post('/test/markets/11111111-0000-4000-8000-000000000001/close')
      .send({ reason: 'oops' });
    expect(res.status).toBe(422);
  });

  it('POST /test/markets/:marketId/settle - settles escrow funds', async () => {
    mockIncr.mockResolvedValueOnce(1);
    const res = await request(app)
      .post('/test/markets/11111111-0000-4000-8000-000000000001/settle')
      .send({
        settleAmountUsd: 4_000_000,
        recipient: '0xRecipientAddress',
      });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('settlementId');
    expect(res.body.status).toBe('settlement_scheduled');
  });

  it('POST /test/markets/:marketId/settle - rejects a negative settlement', async () => {
    mockIncr.mockResolvedValueOnce(1);
    const res = await request(app)
      .post('/test/markets/11111111-0000-4000-8000-000000000001/settle')
      .send({
        settleAmountUsd: -5,
        recipient: '0xRecipientAddress',
      });
    expect(res.status).toBe(422);
  });
});