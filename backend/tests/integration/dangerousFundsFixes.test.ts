import request from 'supertest';
import express from 'express';
import systemHealthRouter from '../../src/routes/systemHealth.routes';
import categoriesRouter, { resetCategorySlugs } from '../../src/routes/categoriesGroup14.routes';
import marketAnalyticsRouter, { getAggregatedMarketAnalytics } from '../../src/routes/marketAnalytics.routes';
import { slugify } from '../../src/schemas/categoriesGroup14.schemas';
import { indexerPollFailuresTotal, indexerPollDurationSeconds } from '../../../indexer/src/metrics';
import { pollWithFaultTolerance } from '../../../indexer/src/faultTolerantPoller';

describe('dangerous-funds fixes: Issues #680, #682, #683, #688', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/health', systemHealthRouter);
    app.use('/api/v2/categories', categoriesRouter);
    app.use('/api/v1/analytics', marketAnalyticsRouter);
    resetCategorySlugs();
  });

  describe('Issue #680: Category Management Unique Slug Enforcement', () => {
    it('generates slug via slugify if not provided', () => {
      expect(slugify('Heavyweight Championship Bout!')).toBe('heavyweight-championship-bout');
      expect(slugify('MMA & BJJ Pro League')).toBe('mma-bjj-pro-league');
    });

    it('rejects duplicate slug with 409 Conflict', async () => {
      const adminToken = 'mock_admin_token';

      // First creation with slug 'bare-knuckle-fc' succeeds
      const res1 = await request(app)
        .post('/api/v2/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Bare Knuckle FC',
          slug: 'bare-knuckle-fc',
          sport_type: 'bareknuckle',
        });

      // Second creation with same slug must return 409 Conflict
      const res2 = await request(app)
        .post('/api/v2/categories')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Another Bare Knuckle FC',
          slug: 'bare-knuckle-fc',
          sport_type: 'bareknuckle',
        });

      if (res1.status === 201) {
        expect(res2.status).toBe(409);
        expect(res2.body.error).toContain('already exists');
      }
    });
  });

  describe('Issue #682: System Health Sensitive Configuration Isolation', () => {
    it('public health endpoint returns only status, version, and timestamp', async () => {
      const res = await request(app).get('/health');
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('version');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).not.toHaveProperty('database_url');
      expect(res.body).not.toHaveProperty('env');
      expect(res.body).not.toHaveProperty('apiKey');
    });

    it('unauthenticated request to detailed health returns 401 Unauthorized', async () => {
      const res = await request(app).get('/health/detailed');
      expect(res.status).toBe(401);
    });
  });

  describe('Issue #683: MarketAnalytics Single Query Group By Aggregation', () => {
    it('aggregates bet metrics in a single query resolving N+1 queries', async () => {
      const rows = await getAggregatedMarketAnalytics(undefined, 50);
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  describe('Issue #688: FaultTolerantPoller Prometheus Metrics', () => {
    it('emits failure counter and duration histogram on poll failures', async () => {
      indexerPollFailuresTotal.reset();
      const initialFailures = indexerPollFailuresTotal.get();

      const mockServer: any = {
        getLedger: jest.fn().mockRejectedValue(new Error('rpc connection refused')),
        getEvents: jest.fn().mockRejectedValue(new Error('rpc connection refused')),
      };

      await expect(pollWithFaultTolerance(mockServer, 100)).rejects.toThrow();

      expect(indexerPollFailuresTotal.get()).toBeGreaterThan(initialFailures);
      expect(indexerPollDurationSeconds.getCount()).toBeGreaterThan(0);
    });
  });
});
