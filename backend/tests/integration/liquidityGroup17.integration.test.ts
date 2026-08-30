import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import liquidityGroup17Router from '../../src/routes/liquidityGroup17.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/liquidity', liquidityGroup17Router);
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

describe('API Module Group 17: AMM Liquidity & Staking Endpoints', () => {
  const userSecret = 'test-user-secret-key-32-chars-long!';

  const validUserToken = jwt.sign(
    { sub: 'usr_lp_123', type: 'access', sv: 1 },
    userSecret,
    { expiresIn: '1h' }
  );

  const validStellarAddress = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
  const marketId = 'mkt_boxing_001';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v2/liquidity/pools', () => {
    it('returns filtered and paginated liquidity pools', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            market_id: marketId,
            market_title: 'Fury vs Usyk III',
            category: 'BOXING',
            reserve_a_stroops: '1000000000',
            reserve_b_stroops: '1000000000',
            total_lp_tokens: '1000000000',
            fee_bps: 30,
            tvl_stroops: '2000000000',
            volume_24h_stroops: '500000000',
            apr_bps: 1450,
          },
        ],
      });

      const res = await request(app).get('/api/v2/liquidity/pools?category=BOXING&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pools).toHaveLength(1);
      expect(res.body.data.pools[0].market_id).toBe(marketId);
    });

    it('rejects invalid sort field with 422', async () => {
      const res = await request(app).get('/api/v2/liquidity/pools?sort_by=invalid_sort');

      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/v2/liquidity/pools/:marketId', () => {
    it('returns single pool reserve details and invariant k', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            market_id: marketId,
            market_title: 'Fury vs Usyk III',
            reserve_a_stroops: '1000000000',
            reserve_b_stroops: '1000000000',
            k_invariant: '1000000000000000000',
          },
        ],
      });

      const res = await request(app).get(`/api/v2/liquidity/pools/${marketId}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.market_id).toBe(marketId);
    });

    it('returns 404 when liquidity pool does not exist', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v2/liquidity/pools/non_existent');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/liquidity/pools/:marketId/add', () => {
    const validAddPayload = {
      market_id: marketId,
      amount_a_stroops: '500000000',
      amount_b_stroops: '500000000',
      min_lp_tokens: '400000000',
      max_slippage_bps: 100,
      provider_address: validStellarAddress,
    };

    it('rejects unauthenticated liquidity provision with 401', async () => {
      const res = await request(app)
        .post(`/api/v2/liquidity/pools/${marketId}/add`)
        .send(validAddPayload);

      expect(res.status).toBe(401);
    });

    it('adds liquidity successfully with valid token and payload', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              reserve_a_stroops: '1000000000',
              reserve_b_stroops: '1000000000',
              total_lp_tokens: '1000000000',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              market_id: marketId,
              reserve_a_stroops: '1500000000',
              reserve_b_stroops: '1500000000',
              total_lp_tokens: '1500000000',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const res = await request(app)
        .post(`/api/v2/liquidity/pools/${marketId}/add`)
        .set('Authorization', `Bearer ${validUserToken}`)
        .send(validAddPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.lp_tokens_minted).toBeDefined();
    });

    it('rejects excessive slippage parameter (>5000 bps) with 422', async () => {
      const res = await request(app)
        .post(`/api/v2/liquidity/pools/${marketId}/add`)
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          ...validAddPayload,
          max_slippage_bps: 6000,
        });

      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/v2/liquidity/staking/stake', () => {
    const validStakePayload = {
      pool_id: 'pool_123',
      lp_token_amount: '100000000',
      lock_duration_days: 30,
      staker_address: validStellarAddress,
    };

    it('stakes LP tokens into yield vault successfully', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 1, ...validStakePayload, multiplier_bps: 11500 }],
      });

      const res = await request(app)
        .post('/api/v2/liquidity/staking/stake')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send(validStakePayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.multiplier_bps).toBe(11500);
    });
  });

  describe('GET /api/v2/liquidity/users/:address/positions', () => {
    it('returns LP positions and staked vaults for address', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{ id: 1, pool_id: 'pool_123', lp_token_balance: '50000000' }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: 1, staked_amount: '100000000', multiplier_bps: 11500 }],
        });

      const res = await request(app).get(`/api/v2/liquidity/users/${validStellarAddress}/positions`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.lp_positions).toHaveLength(1);
      expect(res.body.data.staked_vaults).toHaveLength(1);
    });
  });
});
