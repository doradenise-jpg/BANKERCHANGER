import request from 'supertest';
import express from 'express';
import betGroup4Router from '../../src/routes/betGroup4.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/bets', betGroup4Router);
app.use(errorMiddleware);

// Mock DB pool
const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock('../../src/config/db', () => ({
  pool: {
    connect: jest.fn(),
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

const { pool } = require('../../src/config/db');

describe('API Module Group 4: Betting Operations & Slippage Guard Endpoints', () => {
  const validStellarAddress = 'GBZXN7PIRZGNMHGA72YD2MKXT3MYMVGBLMHMT6A2R63FWIFKIIOHPSTA';

  beforeEach(() => {
    jest.clearAllMocks();
    (pool.connect as jest.Mock).mockResolvedValue(mockClient);
  });

  describe('POST /api/v2/bets/place', () => {
    const validBetPayload = {
      market_id: 'mkt_1',
      bettor_address: validStellarAddress,
      side: 'fighter_a',
      amount: '10000000',
      max_slippage_bps: 500,
    };

    it('places bet successfully on open market', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ market_id: 'mkt_1', status: 'open', total_pool: '10000000', pool_a: '5000000' }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: 1, market_id: 'mkt_1', amount: '10000000', side: 'fighter_a' }],
        })
        .mockResolvedValueOnce({}) // UPDATE markets
        .mockResolvedValueOnce({}); // COMMIT

      const res = await request(app)
        .post('/api/v2/bets/place')
        .send(validBetPayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(1);
    });

    it('rejects invalid Stellar address with 422', async () => {
      const res = await request(app)
        .post('/api/v2/bets/place')
        .send({ ...validBetPayload, bettor_address: 'invalid_address' });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects bet when market is not found with 404', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [] }); // No market found

      const res = await request(app)
        .post('/api/v2/bets/place')
        .send(validBetPayload);

      expect(res.status).toBe(404);
    });

    it('rejects non-positive integer amount with 422', async () => {
      const res = await request(app)
        .post('/api/v2/bets/place')
        .send({ ...validBetPayload, amount: '-500' });

      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/v2/bets/user/:address', () => {
    it('returns paginated bets for valid address', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              market_id: 'mkt_1',
              fighter_a: 'Canelo',
              fighter_b: 'Bivol',
              amount: '10000000',
              side: 'fighter_a',
            },
          ],
        });

      const res = await request(app).get(`/api/v2/bets/user/${validStellarAddress}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.bets).toHaveLength(1);
    });

    it('rejects invalid address format with 422', async () => {
      const res = await request(app).get('/api/v2/bets/user/not_a_stellar_key');

      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/v2/bets/calculate-payout', () => {
    it('calculates projected payout accurately', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ market_id: 'mkt_1', total_pool: '100000000', pool_a: '40000000', fee_bps: 200 }],
      });

      const res = await request(app)
        .post('/api/v2/bets/calculate-payout')
        .send({
          market_id: 'mkt_1',
          amount: '10000000',
          side: 'fighter_a',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.projected_payout).toBeDefined();
      expect(res.body.data.multiplier).toBeGreaterThan(0);
    });
  });
});
