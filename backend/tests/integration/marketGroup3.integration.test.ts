import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import marketGroup3Router from '../../src/routes/marketGroup3.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/markets', marketGroup3Router);
app.use(errorMiddleware);

// Mock DB pool
jest.mock('../../src/config/db', () => ({
  pool: {
    query: jest.fn(),
  },
}));

// Mock Redis cache service and Lua scripts
jest.mock('../../src/services/cache.service', () => ({
  redis: {
    ttl: jest.fn().mockResolvedValue(60),
    ping: jest.fn().mockResolvedValue('PONG'),
  },
}));

jest.mock('../../src/services/redis-lua', () => ({
  incrWithExpire: jest.fn().mockResolvedValue(1),
}));

jest.mock('../../src/config/env', () => ({
  getEnv: jest.fn().mockReturnValue({
    ADMIN_JWT_SECRET: 'test-admin-secret-key-32-chars-long!',
    JWT_SECRET: 'test-secret',
    NODE_ENV: 'test',
  }),
}));

const { pool } = require('../../src/config/db');

describe('API Module Group 3: Market Discovery & Lifecycle Endpoints', () => {
  const adminSecret = 'test-admin-secret-key-32-chars-long!';
  const validAdminToken = jwt.sign(
    { sub: 'admin-1', role: 'admin', type: 'access' },
    adminSecret,
    { expiresIn: '1h' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v2/markets', () => {
    it('returns paginated markets on valid query', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({
          rows: [
            { market_id: 'm1', fighter_a: 'Tyson', fighter_b: 'Paul', status: 'open' },
            { market_id: 'm2', fighter_a: 'Fury', fighter_b: 'Usyk', status: 'open' },
          ],
        });

      const res = await request(app)
        .get('/api/v2/markets')
        .query({ page: 1, limit: 10, status: 'open' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.markets).toHaveLength(2);
      expect(res.body.data.pagination.total).toBe(2);
    });

    it('rejects invalid status filter with 422', async () => {
      const res = await request(app)
        .get('/api/v2/markets')
        .query({ status: 'invalid_status' });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects negative minPool with 422', async () => {
      const res = await request(app)
        .get('/api/v2/markets')
        .query({ minPool: -100 });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('GET /api/v2/markets/:id', () => {
    it('returns market details for existing market', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ market_id: 'mkt_123', fighter_a: 'Tyson', fighter_b: 'Paul', status: 'open' }],
      });

      const res = await request(app).get('/api/v2/markets/mkt_123');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.market_id).toBe('mkt_123');
    });

    it('returns 404 when market is not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v2/markets/nonexistent_id');

      expect(res.status).toBe(404);
    });

    it('rejects invalid path parameter syntax with 422', async () => {
      const res = await request(app).get('/api/v2/markets/invalid!id@');

      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/v2/markets', () => {
    const validMarketPayload = {
      fighter_a: 'Canelo Alvarez',
      fighter_b: 'Terence Crawford',
      weight_class: 'Super Middleweight',
      scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      fee_bps: 250,
      lock_before_secs: 1800,
    };

    it('creates market when admin token is provided and payload is valid', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ market_id: 'mkt_new', ...validMarketPayload, status: 'open' }],
      });

      const res = await request(app)
        .post('/api/v2/markets')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send(validMarketPayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.market_id).toBe('mkt_new');
    });

    it('rejects request without admin authorization token with 401', async () => {
      const res = await request(app)
        .post('/api/v2/markets')
        .send(validMarketPayload);

      expect(res.status).toBe(401);
    });

    it('rejects request with missing required fields with 422', async () => {
      const res = await request(app)
        .post('/api/v2/markets')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({ fighter_a: 'Canelo' });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects fee_bps exceeding 1000 with 422', async () => {
      const res = await request(app)
        .post('/api/v2/markets')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({ ...validMarketPayload, fee_bps: 1500 });

      expect(res.status).toBe(422);
    });
  });

  describe('PATCH /api/v2/markets/:id/lock', () => {
    it('locks open market successfully with admin auth', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
        .mockResolvedValueOnce({
          rows: [{ market_id: 'mkt_123', status: 'locked' }],
        });

      const res = await request(app)
        .patch('/api/v2/markets/mkt_123/lock')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({ reason: 'Fight starting soon' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('locked');
    });

    it('rejects locking already locked market with 400', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ status: 'locked' }] });

      const res = await request(app)
        .patch('/api/v2/markets/mkt_123/lock')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({ reason: 'Test' });

      expect(res.status).toBe(400);
    });
  });
});
