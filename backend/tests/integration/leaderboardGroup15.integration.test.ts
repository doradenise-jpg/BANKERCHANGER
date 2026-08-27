import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import leaderboardGroup15Router from '../../src/routes/leaderboardGroup15.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/leaderboards', leaderboardGroup15Router);
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

describe('API Module Group 15: Leaderboards & Tournaments Endpoints', () => {
  const userSecret = 'test-user-secret-key-32-chars-long!';
  const adminSecret = 'test-admin-secret-key-32-chars-long!';

  const validUserToken = jwt.sign(
    { sub: 'usr_123', type: 'access', sv: 1 },
    userSecret,
    { expiresIn: '1h' }
  );

  const validAdminToken = jwt.sign(
    { sub: 'admin_123', role: 'admin', type: 'access' },
    adminSecret,
    { expiresIn: '1h' }
  );

  const validStellarAddress = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v2/leaderboards/global', () => {
    it('returns ranked leaderboard with default pagination and filters', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [
          {
            user_id: 'usr_1',
            username: 'alpha_bettor',
            role: 'user',
            total_bets: 25,
            winning_bets: 20,
            total_volume_stroops: '500000000',
            net_profit_stroops: '250000000',
            win_rate_percentage: '80.00',
            rank_points: 2500,
          },
        ],
      });

      const res = await request(app).get('/api/v2/leaderboards/global?period=all_time&category=BOXING&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.rankings).toHaveLength(1);
      expect(res.body.data.rankings[0].rank).toBe(1);
      expect(res.body.data.rankings[0].username).toBe('alpha_bettor');
    });

    it('rejects invalid leaderboard period with 422', async () => {
      const res = await request(app).get('/api/v2/leaderboards/global?period=invalid_period');

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects invalid limit exceeding 100 with 422', async () => {
      const res = await request(app).get('/api/v2/leaderboards/global?limit=500');

      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/v2/leaderboards/tournaments/:tournamentId', () => {
    it('returns tournament details and participant standings', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'tourn_1',
              name: 'Spring Championship 2026',
              description: 'Top boxing prediction bracket',
              category: 'BOXING',
              entry_fee_stroops: '10000000',
              prize_pool_stroops: '1000000000',
              max_participants: 64,
              status: 'active',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              user_id: 'usr_1',
              username: 'alpha_bettor',
              score: 1500,
              rank: 1,
            },
          ],
        });

      const res = await request(app).get('/api/v2/leaderboards/tournaments/tourn_1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tournament.name).toBe('Spring Championship 2026');
      expect(res.body.data.standings).toHaveLength(1);
    });

    it('returns 404 when tournament is not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/v2/leaderboards/tournaments/unknown_id');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v2/leaderboards/tournaments/:tournamentId/join', () => {
    it('rejects unauthenticated join requests with 401', async () => {
      const res = await request(app)
        .post('/api/v2/leaderboards/tournaments/tourn_1/join')
        .send({
          tournament_id: 'tourn_1',
          entry_fee_stroops: '10000000',
          participant_address: validStellarAddress,
        });

      expect(res.status).toBe(401);
    });

    it('successfully enrolls authenticated user with valid payload', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{ id: 'tourn_1', entry_fee_stroops: '10000000', max_participants: 50, status: 'active' }],
        })
        .mockResolvedValueOnce({
          rows: [{ count: 10 }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              tournament_id: 'tourn_1',
              user_id: 'usr_123',
              participant_address: validStellarAddress,
              score: 0,
            },
          ],
        });

      const res = await request(app)
        .post('/api/v2/leaderboards/tournaments/tourn_1/join')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          tournament_id: 'tourn_1',
          entry_fee_stroops: '10000000',
          participant_address: validStellarAddress,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('Successfully enrolled');
    });

    it('rejects join request with invalid Stellar address with 422', async () => {
      const res = await request(app)
        .post('/api/v2/leaderboards/tournaments/tourn_1/join')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          tournament_id: 'tourn_1',
          entry_fee_stroops: '10000000',
          participant_address: 'INVALID_STELLAR_KEY',
        });

      expect(res.status).toBe(422);
    });
  });

  describe('GET /api/v2/leaderboards/users/:userId/rank', () => {
    it('computes and returns user competitive tier and points', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({
          rows: [{ id: 'usr_123', username: 'pro_bettor' }],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              total_bets: 40,
              winning_bets: 30,
              total_volume_stroops: '6000000000',
              net_profit_stroops: '3000000000',
            },
          ],
        });

      const res = await request(app).get('/api/v2/leaderboards/users/usr_123/rank');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.tier).toBe('DIAMOND');
      expect(res.body.data.win_rate_percentage).toBe('75.00');
    });
  });

  describe('POST /api/v2/leaderboards/admin/tournaments', () => {
    const validTournamentPayload = {
      name: 'Grand Slam Boxing Cup',
      description: 'Annual competitive boxing parimutuel event',
      category: 'BOXING',
      entry_fee_stroops: '25000000',
      prize_pool_stroops: '5000000000',
      start_time: '2026-09-01T00:00:00.000Z',
      end_time: '2026-09-10T00:00:00.000Z',
      max_participants: 128,
      rules: ['Single elimination', 'Must bet on at least 3 fights'],
    };

    it('rejects tournament creation without admin JWT', async () => {
      const res = await request(app)
        .post('/api/v2/leaderboards/admin/tournaments')
        .send(validTournamentPayload);

      expect(res.status).toBe(401);
    });

    it('creates tournament successfully with admin JWT', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'tourn_new', ...validTournamentPayload, status: 'upcoming' }],
      });

      const res = await request(app)
        .post('/api/v2/leaderboards/admin/tournaments')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send(validTournamentPayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Grand Slam Boxing Cup');
    });

    it('rejects tournament with end_time prior to start_time with 422', async () => {
      const res = await request(app)
        .post('/api/v2/leaderboards/admin/tournaments')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({
          ...validTournamentPayload,
          start_time: '2026-09-10T00:00:00.000Z',
          end_time: '2026-09-01T00:00:00.000Z',
        });

      expect(res.status).toBe(422);
    });
  });
});
