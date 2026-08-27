import { Router } from 'express';
import userActivityRouter from '../routes/userActivity.routes';
import marketAnalyticsRouter from '../routes/marketAnalytics.routes';
import transactionHistoryRouter from '../routes/transactionHistory.routes';
import notificationsRouter from '../routes/notifications.routes';
import systemHealthRouter from '../routes/systemHealth.routes';

// ---------------------------------------------------------------------------
// Integration tests for Endpoint Groups 21-25
// ---------------------------------------------------------------------------

// Mock dependencies
jest.mock('../middleware/auth.middleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'test-user-id', role: 'user' };
    next();
  },
}));

jest.mock('../middleware/requireAdminJwt.middleware', () => ({
  requireAdminJwt: (req: any, _res: any, next: any) => {
    req.user = { id: 'admin-user-id', role: 'admin' };
    next();
  },
}));

jest.mock('../config/db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    totalCount: 10,
    idleCount: 5,
    waitingCount: 0,
  },
}));

jest.mock('../config/redis', () => ({
  redis: {
    ping: jest.fn().mockResolvedValue('PONG'),
  },
}));

jest.mock('../services/cache.service', () => ({
  redis: { ping: jest.fn().mockResolvedValue('PONG') },
}));

jest.mock('../services/redis-lua', () => ({
  incrWithExpire: jest.fn().mockResolvedValue(1),
}));

import request from 'supertest';

// We need to create a mini app for testing
function createTestApp(router: Router) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/test', router);
  return app;
}

describe('Endpoint Group 21: User Activity & Preferences', () => {
  const app = createTestApp(userActivityRouter);

  it('GET /test - returns user activity log', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /test - validates query parameters', async () => {
    const res = await request(app).get('/test?page=0');
    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('errors');
  });

  it('PUT /test/user-id/preferences - updates preferences', async () => {
    const res = await request(app)
      .put('/test/test-user-id/preferences')
      .send({ emailNotifications: false });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('preferences');
  });

  it('GET /test/user-id/preferences - returns preferences', async () => {
    const res = await request(app).get('/test/test-user-id/preferences');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('preferences');
  });
});

describe('Endpoint Group 22: Market Analytics & Reporting', () => {
  const app = createTestApp(marketAnalyticsRouter);

  it('GET /test/markets - returns analytics data', async () => {
    const res = await request(app).get('/test/markets?period=24h');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('metrics');
    expect(res.body.period).toBe('24h');
  });

  it('GET /test/markets - validates period enum', async () => {
    const res = await request(app).get('/test/markets?period=invalid');
    expect(res.status).toBe(422);
  });

  it('POST /test/reports - creates a report job', async () => {
    const res = await request(app)
      .post('/test/reports')
      .send({
        reportType: 'market_summary',
        from: '2025-01-01T00:00:00Z',
        to: '2025-01-31T23:59:59Z',
      });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('reportId');
    expect(res.body.status).toBe('processing');
  });

  it('POST /test/reports - rejects invalid date range', async () => {
    const res = await request(app)
      .post('/test/reports')
      .send({
        reportType: 'market_summary',
        from: '2025-12-31T00:00:00Z',
        to: '2025-01-01T00:00:00Z',
      });
    expect(res.status).toBe(422);
  });
});

describe('Endpoint Group 23: Transaction History & Export', () => {
  const app = createTestApp(transactionHistoryRouter);

  it('GET /test - returns transaction history', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
    expect(res.body).toHaveProperty('filters');
  });

  it('GET /test - validates limit', async () => {
    const res = await request(app).get('/test?limit=500');
    expect(res.status).toBe(422);
  });

  it('POST /test/export - exports as CSV', async () => {
    const res = await request(app)
      .post('/test/export')
      .send({ format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });

  it('POST /test/export - exports as JSON', async () => {
    const res = await request(app)
      .post('/test/export')
      .send({ format: 'json' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('columns');
  });
});

describe('Endpoint Group 24: Notifications & Alert Preferences', () => {
  const app = createTestApp(notificationsRouter);

  it('GET /test/user-id/settings - returns notification settings', async () => {
    const res = await request(app).get('/test/test-user-id/settings');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('settings');
  });

  it('PUT /test/user-id/settings - updates notification settings', async () => {
    const res = await request(app)
      .put('/test/test-user-id/settings')
      .send({ channel: 'push', betPlaced: false });
    expect(res.status).toBe(200);
    expect(res.body.settings.channel).toBe('push');
  });

  it('POST /test/test - sends test notification', async () => {
    const res = await request(app)
      .post('/test/test')
      .send({
        type: 'email',
        userId: 'test-user-id',
        template: 'bet_resolved',
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('deliveryId');
  });

  it('POST /test/test - validates template enum', async () => {
    const res = await request(app)
      .post('/test/test')
      .send({
        type: 'email',
        userId: 'test-user-id',
        template: 'invalid_template',
      });
    expect(res.status).toBe(422);
  });
});

describe('Endpoint Group 25: System Health & Diagnostics', () => {
  const app = createTestApp(systemHealthRouter);

  it('GET /test - returns system health', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('components');
    expect(Array.isArray(res.body.components)).toBe(true);
  });

  it('GET /test - filters by component', async () => {
    const res = await request(app).get('/test?components=database');
    expect(res.status).toBe(200);
    const dbComponent = res.body.components.find(
      (c: any) => c.name === 'database',
    );
    expect(dbComponent).toBeDefined();
  });

  it('GET /test/database - returns database status', async () => {
    const res = await request(app).get('/test/database');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('database');
    expect(res.body).toHaveProperty('status');
  });

  it('GET /test/diagnostics - returns system diagnostics', async () => {
    const res = await request(app).get('/test/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('memoryUsage');
  });

  it('GET /test/invalid - rejects invalid component', async () => {
    const res = await request(app).get('/test/invalid');
    expect(res.status).toBe(422);
  });
});
