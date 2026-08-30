import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import userGroup6Router from '../../src/routes/userGroup6.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/users', userGroup6Router);
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

describe('API Module Group 6: User Profiles & KYC Endpoints', () => {
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v2/users/me', () => {
    it('returns user profile when bearer token is valid', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'usr_123', username: 'chibuikem', role: 'user', kyc_tier: 'tier_1' }],
      });

      const res = await request(app)
        .get('/api/v2/users/me')
        .set('Authorization', `Bearer ${validUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.username).toBe('chibuikem');
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v2/users/me');

      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v2/users/me', () => {
    it('updates profile fields with valid payload', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'usr_123', username: 'new_username', email: 'test@example.com' }],
      });

      const res = await request(app)
        .patch('/api/v2/users/me')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({ username: 'new_username', email: 'test@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.username).toBe('new_username');
    });

    it('rejects empty update body with 422', async () => {
      const res = await request(app)
        .patch('/api/v2/users/me')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({});

      expect(res.status).toBe(422);
    });

    it('rejects invalid email format with 422', async () => {
      const res = await request(app)
        .patch('/api/v2/users/me')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({ email: 'not_an_email' });

      expect(res.status).toBe(422);
    });
  });

  describe('POST /api/v2/users/kyc/submit', () => {
    const validKycPayload = {
      full_name: 'Chibuikem Madugba',
      country_code: 'NG',
      document_type: 'passport',
      document_hash: 'e'.repeat(64),
      requested_tier: 'tier_2',
    };

    it('submits KYC application successfully', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 1, user_id: 'usr_123', ...validKycPayload, status: 'pending' }],
      });

      const res = await request(app)
        .post('/api/v2/users/kyc/submit')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send(validKycPayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('pending');
    });

    it('rejects invalid country code length with 422', async () => {
      const res = await request(app)
        .post('/api/v2/users/kyc/submit')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({ ...validKycPayload, country_code: 'NGA' });

      expect(res.status).toBe(422);
    });
  });

  describe('PATCH /api/v2/users/:id/role', () => {
    it('updates user role with admin token', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rows: [{ id: 'usr_123', role: 'moderator' }],
      });

      const res = await request(app)
        .patch('/api/v2/users/usr_123/role')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({ role: 'moderator', reason: 'Promoted to community moderator' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.role).toBe('moderator');
    });
  });
});
