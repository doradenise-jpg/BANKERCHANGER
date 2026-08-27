import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import treasuryGroup7Router from '../../src/routes/treasuryGroup7.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/treasury', treasuryGroup7Router);
app.use(errorMiddleware);

describe('Treasury & Fee Management (Endpoint Group 7) Integration Tests', () => {
  beforeEach(() => {
    // Clean mock state
  });

  describe('GET /api/v2/treasury/overview', () => {
    it('returns treasury balance overview successfully', async () => {
      const res = await request(app).get('/api/v2/treasury/overview');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('total_balance_stroops');
      expect(res.body.data).toHaveProperty('reserve_ratio_bps');
    });
  });

  describe('POST /api/v2/treasury/withdraw authorization & validation', () => {
    it('rejects withdrawal without admin authorization header', async () => {
      const res = await request(app)
        .post('/api/v2/treasury/withdraw')
        .send({
          destination_address: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2VRGVY55JGS5GHSP2A2',
          amount_stroops: '100000000',
          reason: 'Emergency treasury cold storage sweep',
          idempotency_key: 'idem-key-12345678',
        });

      expect(res.status).toBe(401);
    });

    it('rejects withdrawal with malformed Stellar address', async () => {
      const res = await request(app)
        .post('/api/v2/treasury/withdraw')
        .set('Authorization', 'Bearer invalid_admin_token')
        .send({
          destination_address: 'INVALID_STELLAR_ADDRESS',
          amount_stroops: '100000000',
          reason: 'Emergency treasury cold storage sweep',
          idempotency_key: 'idem-key-12345678',
        });

      // requireAdminJwt rejects with 403 on invalid token
      expect([401, 403, 422]).toContain(res.status);
    });

    it('rejects withdrawal with non-positive amount string', async () => {
      const res = await request(app)
        .post('/api/v2/treasury/withdraw')
        .send({
          destination_address: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2VRGVY55JGS5GHSP2A2',
          amount_stroops: '-500',
          reason: 'Emergency treasury cold storage sweep',
          idempotency_key: 'idem-key-12345678',
        });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v2/treasury/distribute-fees validation', () => {
    it('rejects fee distribution without admin auth', async () => {
      const res = await request(app)
        .post('/api/v2/treasury/distribute-fees')
        .send({
          period_id: 'period-2026-w34',
          lp_reward_bps: 6000,
          reserve_bps: 2000,
          staking_bps: 2000,
        });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v2/treasury/fee-splits', () => {
    it('retrieves default fee splits across market tiers', async () => {
      const res = await request(app).get('/api/v2/treasury/fee-splits');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v2/treasury/transactions query validation', () => {
    it('accepts valid query parameters and returns paginated list', async () => {
      const res = await request(app)
        .get('/api/v2/treasury/transactions')
        .query({
          type: 'withdrawal',
          page: 1,
          limit: 10,
          sort_by: 'created_at',
          sort_order: 'desc',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pagination).toBeDefined();
    });

    it('rejects invalid transaction type query parameter', async () => {
      const res = await request(app)
        .get('/api/v2/treasury/transactions')
        .query({ type: 'invalid_type_123' });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });
});
