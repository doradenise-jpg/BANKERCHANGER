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

jest.mock('../../src/utils/distributedLock', () => ({
  acquireLock: jest.fn().mockResolvedValue(null),
}));

const { pool } = require('../../src/config/db');
const { acquireLock } = require('../../src/utils/distributedLock');

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
      const release = jest.fn().mockResolvedValue(undefined);
      (acquireLock as jest.Mock).mockResolvedValueOnce({ release });
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
      expect(acquireLock).toHaveBeenCalledWith({ key: 'bet:market:mkt_1', ttl: 60 });
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('keeps 50 concurrent bets consistent under the market row lock', async () => {
      let totalPool = 10_000_000n;
      let poolA = 10_000_000n;
      let insertedBets = 0;
      let rowLockTail = Promise.resolve();

      (pool.connect as jest.Mock).mockImplementation(async () => {
        let releaseTransactionLock: (() => void) | undefined;
        const query = jest.fn(async (sql: string, values: unknown[] = []) => {
          if (sql === 'BEGIN') return {};

          if (sql.includes('SELECT * FROM markets')) {
            expect(sql).toMatch(/FOR UPDATE/i);
            const previousLock = rowLockTail;
            let releaseRowLock!: () => void;
            rowLockTail = new Promise<void>((resolve) => {
              releaseRowLock = resolve;
            });
            await previousLock;
            releaseTransactionLock = releaseRowLock;
            return {
              rows: [{
                market_id: 'mkt_1',
                status: 'open',
                total_pool: totalPool.toString(),
                pool_a: poolA.toString(),
              }],
            };
          }

          if (sql.includes('INSERT INTO bets')) {
            insertedBets += 1;
            return {
              rows: [{
                id: insertedBets,
                market_id: 'mkt_1',
                amount: values[3],
                side: 'fighter_a',
              }],
            };
          }

          if (sql.includes('UPDATE markets')) {
            const amount = BigInt(String(values[0]));
            totalPool += amount;
            poolA += amount;
            return {};
          }

          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            releaseTransactionLock?.();
            releaseTransactionLock = undefined;
            return {};
          }

          throw new Error(`Unexpected query: ${sql}`);
        });

        return { query, release: jest.fn() };
      });

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          request(app)
            .post('/api/v2/bets/place')
            .send({
              ...validBetPayload,
              amount: '1000000',
              idempotency_key: `concurrent-${index}`,
            })
        )
      );

      expect(responses.every((response) => response.status === 201)).toBe(true);
      expect(insertedBets).toBe(50);
      expect(totalPool).toBe(60_000_000n);
      expect(poolA).toBe(60_000_000n);
      expect(acquireLock).toHaveBeenCalledTimes(50);
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
