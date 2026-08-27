import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import affiliateGroup18Router from '../../src/routes/affiliateGroup18.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/affiliates', affiliateGroup18Router);
app.use(errorMiddleware);

// Mock DB pool
jest.mock('../../src/config/db', () => ({
  pool: {
    query: jest.fn(),
  },
}));

// Mock Redis
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
    JWT_SECRET: 'test-user-secret-key-32-chars-long!',
    NODE_ENV: 'test',
  }),
}));

jest.mock('../../src/services/auth.service', () => ({
  isSessionRevoked: jest.fn().mockResolvedValue(false),
}));

const { pool } = require('../../src/config/db');

describe('API Module Group 18: Affiliate & Referrals Endpoints', () => {
  const userSecret = 'test-user-secret-key-32-chars-long!';
  const adminSecret = 'test-admin-secret-key-32-chars-long!';

  const validUserToken = jwt.sign(
    { sub: 'usr_affiliate_123', type: 'access', sv: 1 },
    userSecret,
    { expiresIn: '1h' }
  );

  const validAdminToken = jwt.sign(
    { sub: 'admin_123', role: 'admin', type: 'access' },
    adminSecret,
    { expiresIn: '1h' }
  );

  const validStellarAddress = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
  const refereeAddress = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v2/affiliates/codes/create', () => {
    const validCodePayload = {
      code: 'CHAMPION2026',
      rebate_percentage_bps: 1000,
      campaign_name: 'Summer Promo',
      creator_address: validStellarAddress,
    };

    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app)
        .post('/api/v2/affiliates/codes/create')
        .send(validCodePayload);

      expect(res.status).toBe(401);
    });

    it('creates referral code successfully with valid token and payload', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{ id: 1, ...validCodePayload, creator_id: 'usr_affiliate_123', status: 'active' }],
        });

      const res = await request(app)
        .post('/api/v2/affiliates/codes/create')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send(validCodePayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.code).toBe('CHAMPION2026');
    });

    it('rejects invalid code with special characters with 422', async () => {
      const res = await request(app)
        .post('/api/v2/affiliates/codes/create')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          ...validCodePayload,
          code: 'INVALID CODE!',
        });

      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/v2/affiliates/referrals/apply', () => {
    const validApplyPayload = {
      referral_code: 'CHAMPION2026',
      referee_address: refereeAddress,
    };

    it('applies referral code successfully', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{ id: 1, creator_id: 'other_user_456', rebate_percentage_bps: 1000, status: 'active' }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: 1, affiliate_code_id: 1, referee_user_id: 'usr_affiliate_123' }],
        });

      const res = await request(app)
        .post('/api/v2/affiliates/referrals/apply')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send(validApplyPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.referral_code).toBe('CHAMPION2026');
    });
  });

  describe('GET /api/v2/affiliates/dashboard', () => {
    it('returns affiliate overview statistics', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              code: 'CHAMPION2026',
              referrals_count: 15,
              total_volume_stroops: '5000000000',
              total_earnings_stroops: '500000000',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              unclaimed_commissions_stroops: '250000000',
              total_paid_stroops: '250000000',
              tier: 'gold',
            },
          ],
        });

      const res = await request(app)
        .get('/api/v2/affiliates/dashboard?period=30d')
        .set('Authorization', `Bearer ${validUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.profile.tier).toBe('gold');
      expect(res.body.data.campaigns).toHaveLength(1);
    });
  });

  describe('POST /api/v2/affiliates/payouts/claim', () => {
    it('claims accrued commissions successfully', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{ unclaimed_commissions_stroops: '500000000' }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              recipient_address: validStellarAddress,
              amount_stroops: '200000000',
              status: 'processed',
            },
          ],
        });

      const res = await request(app)
        .post('/api/v2/affiliates/payouts/claim')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          recipient_address: validStellarAddress,
          amount_stroops: '200000000',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('processed');
    });
  });

  describe('PATCH /api/v2/affiliates/admin/tier-override', () => {
    const validOverridePayload = {
      user_id: 'usr_affiliate_123',
      tier: 'platinum',
      custom_commission_bps: 2500,
      reason: 'Key promotional partner for WBC title bouts',
    };

    it('rejects tier override without admin token', async () => {
      const res = await request(app)
        .patch('/api/v2/affiliates/admin/tier-override')
        .send(validOverridePayload);

      expect(res.status).toBe(401);
    });

    it('applies tier override successfully with admin token', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 1, ...validOverridePayload }],
      });

      const res = await request(app)
        .patch('/api/v2/affiliates/admin/tier-override')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send(validOverridePayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tier).toBe('platinum');
    });
  });
});
