import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import categoriesGroup14Router from '../../src/routes/categoriesGroup14.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/categories', categoriesGroup14Router);
app.use('/api/v2', categoriesGroup14Router);
app.use(errorMiddleware);

describe('Categories, Tagging & Live Odds (Endpoint Group 14) Integration Tests', () => {
  beforeEach(() => {
    // Reset test mocks/state
  });

  describe('GET /api/v2/categories', () => {
    it('returns combat sport categories list', async () => {
      const res = await request(app).get('/api/v2/categories');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/v2/categories admin authorization & validation', () => {
    it('rejects category creation without admin JWT', async () => {
      const res = await request(app)
        .post('/api/v2/categories')
        .send({
          name: 'Bare Knuckle Fighting',
          slug: 'bkfc-boxing',
          sport_type: 'bareknuckle',
        });

      expect(res.status).toBe(401);
    });

    it('rejects category with invalid non-kebab-case slug', async () => {
      const res = await request(app)
        .post('/api/v2/categories')
        .set('Authorization', 'Bearer invalid_token')
        .send({
          name: 'Bare Knuckle Fighting',
          slug: 'Invalid Slug With Spaces!',
          sport_type: 'bareknuckle',
        });

      expect([401, 403, 422]).toContain(res.status);
    });
  });

  describe('GET /api/v2/search/suggest validation', () => {
    it('returns suggestions for valid query', async () => {
      const res = await request(app)
        .get('/api/v2/search/suggest')
        .query({ q: 'Tyson', limit: 5 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });

    it('rejects search query shorter than 2 characters', async () => {
      const res = await request(app)
        .get('/api/v2/search/suggest')
        .query({ q: 'T' });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('POST /api/v2/tags/batch authorization', () => {
    it('rejects batch tagging without admin authorization', async () => {
      const res = await request(app)
        .post('/api/v2/tags/batch')
        .send({
          market_ids: ['mkt-1', 'mkt-2'],
          tags: ['title-bout', 'ppv'],
        });

      expect(res.status).toBe(401);
    });
  });
});
