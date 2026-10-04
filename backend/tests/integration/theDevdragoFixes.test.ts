import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import treasuryGroup7Router from '../../src/routes/treasuryGroup7.routes';
import transactionHistoryRouter from '../../src/routes/transactionHistory.routes';
import * as StellarService from '../../src/services/StellarService';
import * as authService from '../../src/services/auth.service';
import { requireAuth } from '../../src/middleware/auth.middleware';
import { errorMiddleware } from '../../src/middleware/error.middleware';
import {
  processEvent,
  indexer_duplicate_events_skipped_total,
  getIndexerDuplicateEventsSkippedTotal,
  resetIndexerDuplicateEventsSkippedTotal,
} from '../../../indexer/src/poller';
import { recordProcessedEvent, isEventProcessed } from '../../../indexer/src/db';

// Mock DB pool for treasury tests
jest.mock('../../src/config/db', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

// Mock Redis
jest.mock('../../src/services/cache.service', () => ({
  redis: {
    ttl: jest.fn().mockResolvedValue(60),
    ping: jest.fn().mockResolvedValue('PONG'),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  },
}));

jest.mock('../../src/services/redis-lua', () => ({
  incrWithExpire: jest.fn().mockResolvedValue(1),
}));

jest.mock('../../src/config/env', () => ({
  getEnv: jest.fn().mockReturnValue({
    ADMIN_JWT_SECRET: 'test-admin-secret-key-32-chars-long!',
    JWT_SECRET: 'test-user-secret-key-32-chars-long!',
    NODE_ENV: 'test',
  }),
}));

const { pool } = require('../../src/config/db');

const app = express();
app.use(express.json());
app.use('/api/v2/treasury', treasuryGroup7Router);
app.use('/api/v1/transactions', transactionHistoryRouter);

// Test endpoint protected by requireAuth
app.get('/test/protected', requireAuth, (req, res) => {
  res.status(200).json({ success: true, userId: (req as any).userId });
});

app.use(errorMiddleware);

describe('the-Devdrago Issues Suite (#679, #685, #686, #687)', () => {
  const adminSecret = 'test-admin-secret-key-32-chars-long!';
  const userSecret = 'test-user-secret-key-32-chars-long!';

  const validAdminToken = jwt.sign(
    { sub: 'adm_123', role: 'admin', type: 'access' },
    adminSecret,
    { expiresIn: '1h' }
  );

  const validUserToken = jwt.sign(
    { sub: 'usr_devdrago_1', type: 'access', sv: 0, password_version: 0 },
    userSecret,
    { expiresIn: '1h' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    resetIndexerDuplicateEventsSkippedTotal();
  });

  // =========================================================================
  // ISSUE #679: Treasury Routes Validate Withdrawal Against Balance
  // =========================================================================
  describe('Issue #679: Treasury Withdrawal Balance Validation', () => {
    it('returns 400 Insufficient treasury balance when requested amount exceeds balance', async () => {
      // Mock StellarService to report 50,000,000 stroops (5 XLM)
      jest.spyOn(StellarService, 'getTreasuryBalance').mockResolvedValueOnce('50000000');

      const res = await request(app)
        .post('/api/v2/treasury/withdraw')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({
          destination_address: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2VRGVY55JGS5GHSP2A2',
          amount_stroops: '100000000', // 10 XLM (exceeds balance)
          reason: 'Excessive withdrawal',
          idempotency_key: 'idem-withdraw-fail-1',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Insufficient treasury balance');
      // Ensure no DB query was executed for the withdrawal
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('allows withdrawal when amount is within current treasury balance', async () => {
      // Mock balance of 500,000,000 stroops
      jest.spyOn(StellarService, 'getTreasuryBalance').mockResolvedValueOnce('500000000');

      const mockClient = {
        query: jest.fn().mockImplementation((queryText: string) => {
          if (queryText === 'BEGIN' || queryText === 'COMMIT') return Promise.resolve();
          return Promise.resolve({
            rows: [
              {
                id: 'ttx-1',
                type: 'withdrawal',
                destination_address: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2VRGVY55JGS5GHSP2A2',
                amount_stroops: '100000000',
                reason: 'Normal withdrawal',
                status: 'completed',
                created_at: new Date().toISOString(),
              },
            ],
          });
        }),
        release: jest.fn(),
      };
      (pool.connect as jest.Mock).mockResolvedValueOnce(mockClient);

      const res = await request(app)
        .post('/api/v2/treasury/withdraw')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({
          destination_address: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2VRGVY55JGS5GHSP2A2',
          amount_stroops: '100000000',
          reason: 'Normal withdrawal',
          idempotency_key: 'idem-withdraw-pass-1',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.amount_stroops).toBe('100000000');
    });
  });

  // =========================================================================
  // ISSUE #685: Invalidate Sessions on Password Change via password_version
  // =========================================================================
  describe('Issue #685: Auth Service Session Invalidation via password_version', () => {
    it('rejects access token with stale password_version after password change', async () => {
      // Old token issued with password_version: 0
      const oldToken = jwt.sign(
        { sub: 'usr_devdrago_1', type: 'access', sv: 0, password_version: 0 },
        userSecret,
        { expiresIn: '1h' }
      );

      // Mock isPasswordVersionStale to report true (stale)
      jest.spyOn(authService, 'isPasswordVersionStale').mockResolvedValueOnce(true);

      const res = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${oldToken}`);

      expect(res.status).toBe(401);
    });

    it('accepts access token with updated password_version', async () => {
      // New token issued with password_version: 1
      const newToken = jwt.sign(
        { sub: 'usr_devdrago_1', type: 'access', sv: 1, password_version: 1 },
        userSecret,
        { expiresIn: '1h' }
      );

      jest.spyOn(authService, 'isSessionRevoked').mockResolvedValueOnce(false);
      jest.spyOn(authService, 'isPasswordVersionStale').mockResolvedValueOnce(false);

      const res = await request(app)
        .get('/test/protected')
        .set('Authorization', `Bearer ${newToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.userId).toBe('usr_devdrago_1');
    });
  });

  // =========================================================================
  // ISSUE #686: Transaction History Export Limits (90-day & 100k cap)
  // =========================================================================
  describe('Issue #686: Transaction History Export Limits & Streaming', () => {
    it('returns 413 Payload Too Large when export date range exceeds 90 days', async () => {
      const from = '2026-01-01T00:00:00.000Z';
      const to = '2026-05-01T00:00:00.000Z'; // 120 days (> 90 days)

      const res = await request(app)
        .post('/api/v1/transactions/export')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          format: 'csv',
          filters: { from, to },
        });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('Payload Too Large');
      expect(res.body.message).toContain('90-day');
    });

    it('returns 413 Payload Too Large when record count exceeds 100,000 rows', async () => {
      const from = '2026-01-01T00:00:00.000Z';
      const to = '2026-02-01T00:00:00.000Z'; // 31 days (valid)

      const res = await request(app)
        .post('/api/v1/transactions/export')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          format: 'csv',
          filters: { from, to },
          estimated_count: 150000, // Exceeds 100,000 limit
        });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('Payload Too Large');
      expect(res.body.message).toContain('100,000');
    });

    it('streams export data successfully when within limits', async () => {
      const from = '2026-01-01T00:00:00.000Z';
      const to = '2026-02-01T00:00:00.000Z';

      const res = await request(app)
        .post('/api/v1/transactions/export')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          format: 'csv',
          filters: { from, to },
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment; filename="transactions.csv"');
      expect(res.text).toContain('id,userId,type,amount,status,marketId,createdAt');
    });
  });

  // =========================================================================
  // ISSUE #687: Poller Deduplication Across Restarts
  // =========================================================================
  describe('Issue #687: Poller Deduplication & Metric Increment', () => {
    it('deduplicates events across restarts using ON CONFLICT DO NOTHING and increments metric', () => {
      const txHash = 'tx-test-dedup-1';
      const eventIndex = 0;

      // First time event is processed
      const firstInsert = recordProcessedEvent(txHash, eventIndex, 'submitted', 1001, '{}');
      expect(firstInsert).toBe(true);

      // Second time same event is processed (simulating crash restart mid-ledger)
      const secondInsert = recordProcessedEvent(txHash, eventIndex, 'submitted', 1001, '{}');
      expect(secondInsert).toBe(false);

      expect(isEventProcessed(txHash, eventIndex)).toBe(true);
    });

    it('skips duplicate event in processEvent and increments indexer_duplicate_events_skipped_total', () => {
      const mockEvent: any = {
        txHash: 'tx-poller-test-dup-2',
        eventIndex: 1,
        ledger: 1005,
        topic: [{ _arm: 'sym', _value: 'submitted' }],
        value: { id: 'inv-dup-1', amount: 500 },
      };

      const initialSkipped = getIndexerDuplicateEventsSkippedTotal();

      // First processEvent
      processEvent(mockEvent);

      // Second processEvent with identical txHash and eventIndex (duplicate across restart)
      processEvent(mockEvent);

      const afterSkipped = getIndexerDuplicateEventsSkippedTotal();
      expect(afterSkipped).toBe(initialSkipped + 1);
    });
  });
});
