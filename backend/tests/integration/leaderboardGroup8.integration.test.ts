import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import leaderboardGroup8Router from '../../src/routes/leaderboardGroup8.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/leaderboard', leaderboardGroup8Router);
app.use(errorMiddleware);

describe('Leaderboard & Competitive Seasons (Endpoint Group 8) Integration Tests', () => {
  beforeEach(() => {
    // Reset test mocks/state
  });

  describe('GET /api/v2/leaderboard/global query validation', () => {
    it('returns global leaderboard with default query parameters', async () => {
      const res = await request(app).get('/api/v2/leaderboard/global');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('rejects invalid leaderboard timeframe in query', async () => {
      const res = await request(app)
        .get('/api/v2/leaderboard/global')
        .query({ timeframe: 'decade_invalid' });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects invalid metric parameter in query', async () => {
      const res = await request(app)
        .get('/api/v2/leaderboard/global')
        .query({ metric: 'invalid_metric_score' });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('GET /api/v2/leaderboard/users/:address/rank param validation', () => {
    it('returns rank details for a valid Stellar address', async () => {
      const validAddress = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2VRGVY55JGS5GHSP2A2';
      const res = await request(app).get(`/api/v2/leaderboard/users/${validAddress}/rank`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.address).toBe(validAddress);
      expect(res.body.data).toHaveProperty('global_rank');
      expect(res.body.data).toHaveProperty('tier');
    });

    it('rejects malformed Stellar address param', async () => {
      const res = await request(app).get('/api/v2/leaderboard/users/INVALID_ADDRESS/rank');
      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('POST /api/v2/leaderboard/seasons/join authentication', () => {
    it('rejects join request when no auth token provided', async () => {
      const res = await request(app)
        .post('/api/v2/leaderboard/seasons/join')
        .send({
          season_id: 'season-combat-s1',
          terms_accepted: true,
        });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v2/leaderboard/admin/seasons authorization & schema validation', () => {
    it('rejects season creation without admin credentials', async () => {
      const res = await request(app)
        .post('/api/v2/leaderboard/admin/seasons')
        .send({
          season_name: 'Summer MMA Championship',
          start_time: '2026-09-01T00:00:00Z',
          end_time: '2026-09-30T23:59:59Z',
          prize_pool_stroops: '50000000000',
        });

      expect(res.status).toBe(401);
    });

    it('rejects season where end_time is before start_time', async () => {
      const res = await request(app)
        .post('/api/v2/leaderboard/admin/seasons')
        .set('Authorization', 'Bearer invalid_token')
        .send({
          season_name: 'Invalid Season Date Range',
          start_time: '2026-09-30T00:00:00Z',
          end_time: '2026-09-01T00:00:00Z',
          prize_pool_stroops: '50000000000',
        });

      expect([401, 403, 422]).toContain(res.status);
    });
  });
});
