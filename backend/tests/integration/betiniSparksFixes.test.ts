import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import {
  computeWebhookSignature,
  verifyWebhookSignature,
  registerWebhookSubscription,
  clearWebhookSubscriptions,
} from '../../src/routes/webhooksGroup9.routes';
import webhooksGroup9Router from '../../src/routes/webhooksGroup9.routes';
import liquidityGroup17Router, {
  setMarketLockPeriod,
  recordDeposit,
  clearLiquidityLockState,
} from '../../src/routes/liquidityGroup17.routes';
import {
  AFFILIATE_TIERS,
  getTierForVolume,
  calculateCommission,
} from '../../src/constants/affiliateTiers';
import { errorMiddleware } from '../../src/middleware/error.middleware';

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

const app = express();
app.use(express.json());
app.use('/api/v2/webhooks', webhooksGroup9Router);
app.use('/api/v2/liquidity', liquidityGroup17Router);
app.use(errorMiddleware);

describe('betiniSparks Fixes Suite (#673, #674, #675, #681)', () => {
  const userSecret = 'test-user-secret-key-32-chars-long!';
  const validUserToken = jwt.sign(
    { sub: 'usr_betini_123', type: 'access', sv: 1 },
    userSecret,
    { expiresIn: '1h' }
  );
  const testAddress = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
  const marketId = 'mkt_mma_999';

  beforeEach(() => {
    jest.clearAllMocks();
    clearLiquidityLockState();
    clearWebhookSubscriptions();
  });

  describe('Issue #674: Affiliate Commission Off-By-One Tier Boundaries', () => {
    it('accurately evaluates [lower, upper) boundaries for each tier', () => {
      // Bronze: [0, 1000)
      expect(getTierForVolume(0).name).toBe('Bronze');
      expect(getTierForVolume(999.99).name).toBe('Bronze');

      // Silver: [1000, 5000)
      expect(getTierForVolume(1000).name).toBe('Silver');
      expect(getTierForVolume(4999.99).name).toBe('Silver');

      // Gold: [5000, 20000)
      expect(getTierForVolume(5000).name).toBe('Gold');
      expect(getTierForVolume(19999.99).name).toBe('Gold');

      // Platinum: [20000, 50000)
      expect(getTierForVolume(20000).name).toBe('Platinum');
      expect(getTierForVolume(49999.99).name).toBe('Platinum');

      // Diamond: [50000, Infinity)
      expect(getTierForVolume(50000).name).toBe('Diamond');
      expect(getTierForVolume(100000).name).toBe('Diamond');
    });

    it('correctly calculates commission without off-by-one errors at boundaries', () => {
      // 1000 exactly should get Silver rate (7.5%)
      const comm1000 = calculateCommission(1000, 100);
      expect(comm1000).toBe(7.5);

      // 5000 exactly should get Gold rate (10.0%)
      const comm5000 = calculateCommission(5000, 100);
      expect(comm5000).toBe(10);
    });
  });

  describe('Issue #675: Liquidity Withdrawal Lock Period', () => {
    it('returns 423 Locked with Unlock-Time header if within lock period', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Set lock period of 3600 seconds
      setMarketLockPeriod(marketId, 3600);
      // Record deposit 100 seconds ago
      recordDeposit(marketId, testAddress, nowSeconds - 100);

      const res = await request(app)
        .post(`/api/v2/liquidity/pools/${marketId}/remove`)
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          market_id: marketId,
          lp_tokens_to_burn: '1000000',
          min_amount_a_stroops: '1000',
          min_amount_b_stroops: '1000',
          provider_address: testAddress,
        });

      expect(res.status).toBe(423);
      expect(res.headers['unlock-time']).toBeDefined();
      expect(res.body.success).toBe(false);
      expect(res.body.data.market_id).toBe(marketId);
    });

    it('allows withdrawal when lock period has passed', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      setMarketLockPeriod(marketId, 3600);
      // Record deposit 4000 seconds ago (lock expired)
      recordDeposit(marketId, testAddress, nowSeconds - 4000);

      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              reserve_a_stroops: '10000000',
              reserve_b_stroops: '10000000',
              total_lp_tokens: '10000000',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              reserve_a_stroops: '9000000',
              reserve_b_stroops: '9000000',
              total_lp_tokens: '9000000',
            },
          ],
        });

      const res = await request(app)
        .post(`/api/v2/liquidity/pools/${marketId}/remove`)
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          market_id: marketId,
          lp_tokens_to_burn: '1000000',
          min_amount_a_stroops: '1000',
          min_amount_b_stroops: '1000',
          provider_address: testAddress,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('Issue #681: Webhook HMAC Signature Verification', () => {
    const testSecret = 'secret_key_1234567890_very_secure';
    const samplePayload = { event: 'market.created', market_id: 'mkt_boxing_42' };

    it('verifies valid HMAC-SHA256 signature using timingSafeEqual', () => {
      const validSig = computeWebhookSignature(samplePayload, testSecret);
      expect(verifyWebhookSignature(samplePayload, validSig, testSecret)).toBe(true);
      expect(verifyWebhookSignature(samplePayload, `sha256=${validSig}`, testSecret)).toBe(true);
    });

    it('rejects tampered payload or forged signature', () => {
      const validSig = computeWebhookSignature(samplePayload, testSecret);
      expect(verifyWebhookSignature({ event: 'hacked' }, validSig, testSecret)).toBe(false);
      expect(verifyWebhookSignature(samplePayload, 'forgedsignature12345678', testSecret)).toBe(false);
      expect(verifyWebhookSignature(samplePayload, null, testSecret)).toBe(false);
    });

    it('delivery-callback returns 401 when signature header is missing or invalid', async () => {
      const resNoSig = await request(app)
        .post('/api/v2/webhooks/delivery-callback')
        .send(samplePayload);
      expect(resNoSig.status).toBe(401);

      const resBadSig = await request(app)
        .post('/api/v2/webhooks/delivery-callback')
        .set('X-Signature', 'invalid_sig_hex')
        .send(samplePayload);
      expect(resBadSig.status).toBe(401);
    });

    it('inbound/:id verifies signature against per-subscription secret', async () => {
      const subId = 'whk-custom-sub-1';
      registerWebhookSubscription({
        id: subId,
        url: 'https://example.com/wh',
        secret: testSecret,
        topics: ['market.created'],
        status: 'active',
        created_at: new Date().toISOString(),
      });

      const validSig = computeWebhookSignature(samplePayload, testSecret);

      const res = await request(app)
        .post(`/api/v2/webhooks/inbound/${subId}`)
        .set('X-Signature', validSig)
        .send(samplePayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
