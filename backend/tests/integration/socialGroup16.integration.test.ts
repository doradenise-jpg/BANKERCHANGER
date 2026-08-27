import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import socialGroup16Router from '../../src/routes/socialGroup16.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/social', socialGroup16Router);
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

describe('API Module Group 16: Social Syndicates & Copy-Trading Endpoints', () => {
  const userSecret = 'test-user-secret-key-32-chars-long!';

  const validUserToken = jwt.sign(
    { sub: 'usr_syndicate_123', type: 'access', sv: 1 },
    userSecret,
    { expiresIn: '1h' }
  );

  const validStellarAddress = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
  const targetTraderAddress = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v2/social/syndicates', () => {
    it('returns filtered and paginated syndicate list', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: 'syn_1',
            name: 'Heavyweight Sharps',
            description: 'Specializing in heavyweight boxing knockouts',
            leader_address: validStellarAddress,
            min_stake_stroops: '50000000',
            max_members: 20,
            manager_fee_bps: 500,
            member_count: 8,
            total_staked_stroops: '400000000',
            roi_bps: 1850,
          },
        ],
      });

      const res = await request(app).get('/api/v2/social/syndicates?status=recruiting&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.syndicates).toHaveLength(1);
      expect(res.body.data.syndicates[0].name).toBe('Heavyweight Sharps');
    });

    it('rejects invalid limit parameter with 422', async () => {
      const res = await request(app).get('/api/v2/social/syndicates?limit=250');

      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/v2/social/syndicates/:syndicateId', () => {
    it('returns syndicate details and member breakdown', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'syn_1',
              name: 'Heavyweight Sharps',
              total_pool_stroops: '400000000',
              current_members: 8,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              member_address: validStellarAddress,
              stake_stroops: '50000000',
              share_percentage: '12.5',
            },
          ],
        });

      const res = await request(app).get('/api/v2/social/syndicates/syn_1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.syndicate.name).toBe('Heavyweight Sharps');
      expect(res.body.data.members).toHaveLength(1);
    });

    it('returns 404 when syndicate does not exist', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v2/social/syndicates/non_existent');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/social/syndicates', () => {
    const validSyndicatePayload = {
      name: 'Apex Predictors',
      description: 'Algorithmically hedged MMA and Boxing syndicate',
      leader_address: validStellarAddress,
      min_stake_stroops: '100000000',
      max_members: 50,
      manager_fee_bps: 1000,
      is_private: false,
      allowed_categories: ['BOXING', 'MMA'],
    };

    it('rejects syndicate creation without authentication', async () => {
      const res = await request(app)
        .post('/api/v2/social/syndicates')
        .send(validSyndicatePayload);

      expect(res.status).toBe(401);
    });

    it('creates syndicate successfully with valid token and payload', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'syn_new_1', ...validSyndicatePayload, status: 'recruiting' }],
      });

      const res = await request(app)
        .post('/api/v2/social/syndicates')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send(validSyndicatePayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Apex Predictors');
    });

    it('rejects excessive manager fee (>3000 bps) with 422', async () => {
      const res = await request(app)
        .post('/api/v2/social/syndicates')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          ...validSyndicatePayload,
          manager_fee_bps: 5000,
        });

      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/v2/social/copy-trade/follow', () => {
    const validCopyTradePayload = {
      trader_address: targetTraderAddress,
      copy_ratio_bps: 5000,
      max_stake_per_bet_stroops: '250000000',
      daily_stop_loss_stroops: '1000000000',
      max_slippage_bps: 200,
    };

    it('configures copy-trade rule successfully for authenticated user', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 1, follower_id: 'usr_syndicate_123', ...validCopyTradePayload, status: 'active' }],
      });

      const res = await request(app)
        .post('/api/v2/social/copy-trade/follow')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send(validCopyTradePayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('Copy-trading subscription active');
    });

    it('rejects copy ratio below 1% (100 bps) with 422', async () => {
      const res = await request(app)
        .post('/api/v2/social/copy-trade/follow')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          ...validCopyTradePayload,
          copy_ratio_bps: 50,
        });

      expect(res.status).toBe(422);
    });
  });

  describe('DELETE /api/v2/social/copy-trade/unfollow/:traderAddress', () => {
    it('pauses copy trading subscription successfully', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 1, target_trader_address: targetTraderAddress, status: 'paused' }],
      });

      const res = await request(app)
        .delete(`/api/v2/social/copy-trade/unfollow/${targetTraderAddress}`)
        .set('Authorization', `Bearer ${validUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('paused successfully');
    });
  });
});
