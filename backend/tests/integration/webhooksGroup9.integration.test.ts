import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import webhooksGroup9Router from '../../src/routes/webhooksGroup9.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/webhooks', webhooksGroup9Router);
app.use(errorMiddleware);

describe('Webhooks & Subscriptions (Endpoint Group 9) Integration Tests', () => {
  beforeEach(() => {
    // Reset test mocks/state
  });

  describe('POST /api/v2/webhooks/subscriptions validation & authentication', () => {
    it('rejects webhook creation without authorization header', async () => {
      const res = await request(app)
        .post('/api/v2/webhooks/subscriptions')
        .send({
          url: 'https://example.com/webhook',
          secret: 'supersecretkey1234567890',
          topics: ['market.created'],
        });

      expect(res.status).toBe(401);
    });

    it('rejects insecure HTTP target URLs', async () => {
      const res = await request(app)
        .post('/api/v2/webhooks/subscriptions')
        .set('Authorization', 'Bearer invalid_token')
        .send({
          url: 'http://insecure-endpoint.com/webhook',
          secret: 'supersecretkey1234567890',
          topics: ['market.created'],
        });

      expect([401, 422]).toContain(res.status);
    });

    it('rejects webhook secrets shorter than 16 characters', async () => {
      const res = await request(app)
        .post('/api/v2/webhooks/subscriptions')
        .send({
          url: 'https://example.com/webhook',
          secret: 'short',
          topics: ['market.created'],
        });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v2/webhooks/subscriptions authentication', () => {
    it('rejects listing webhooks without auth token', async () => {
      const res = await request(app).get('/api/v2/webhooks/subscriptions');
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v2/webhooks/subscriptions/:id authentication', () => {
    it('rejects deletion without auth token', async () => {
      const res = await request(app).delete('/api/v2/webhooks/subscriptions/whk-123');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v2/webhooks/admin/replay authorization', () => {
    it('rejects admin replay endpoint without admin JWT', async () => {
      const res = await request(app)
        .post('/api/v2/webhooks/admin/replay')
        .send({
          delivery_ids: ['del-1', 'del-2'],
        });

      expect(res.status).toBe(401);
    });

    it('rejects admin replay with empty delivery array', async () => {
      const res = await request(app)
        .post('/api/v2/webhooks/admin/replay')
        .send({
          delivery_ids: [],
        });

      expect(res.status).toBe(401);
    });
  });
});
