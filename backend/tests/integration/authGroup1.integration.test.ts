import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import authGroup1Router from '../../src/routes/authGroup1.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/auth', authGroup1Router);
app.use(errorMiddleware);

describe('Auth Group 1 API Module Integration Tests', () => {
  beforeEach(() => {
    // Reset test state if needed
  });

  describe('POST /api/v2/auth/register', () => {
    it('rejects registration with invalid email format', async () => {
      const res = await request(app)
        .post('/api/v2/auth/register')
        .send({
          email: 'not-an-email',
          username: 'validuser',
          password: 'Password123!',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects registration with weak password', async () => {
      const res = await request(app)
        .post('/api/v2/auth/register')
        .send({
          email: 'user@example.com',
          username: 'validuser',
          password: 'weak',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects registration with invalid username characters', async () => {
      const res = await request(app)
        .post('/api/v2/auth/register')
        .send({
          email: 'user@example.com',
          username: 'user@invalid!',
          password: 'Password123!',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects registration with invalid Stellar wallet address format', async () => {
      const res = await request(app)
        .post('/api/v2/auth/register')
        .send({
          email: 'user@example.com',
          username: 'validuser',
          password: 'Password123!',
          stellar_wallet_address: 'invalid_stellar_address',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('POST /api/v2/auth/login', () => {
    it('rejects login with missing password', async () => {
      const res = await request(app)
        .post('/api/v2/auth/login')
        .send({
          email: 'user@example.com',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects login with invalid email format', async () => {
      const res = await request(app)
        .post('/api/v2/auth/login')
        .send({
          email: 'not-valid-email',
          password: 'Password123!',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('POST /api/v2/auth/refresh', () => {
    it('rejects refresh token requests with empty token', async () => {
      const res = await request(app)
        .post('/api/v2/auth/refresh')
        .send({
          refreshToken: '',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects refresh token requests with short/invalid token', async () => {
      const res = await request(app)
        .post('/api/v2/auth/refresh')
        .send({
          refreshToken: 'short_token',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('POST /api/v2/auth/mfa/verify', () => {
    it('rejects MFA verification with invalid code length', async () => {
      const res = await request(app)
        .post('/api/v2/auth/mfa/verify')
        .send({
          tempToken: 'valid_temp_token_format_12345',
          code: '123',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects MFA verification with non-numeric code', async () => {
      const res = await request(app)
        .post('/api/v2/auth/mfa/verify')
        .send({
          tempToken: 'valid_temp_token_format_12345',
          code: 'abcdef',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('POST /api/v2/auth/password/reset-confirm', () => {
    it('rejects password reset with weak new password', async () => {
      const res = await request(app)
        .post('/api/v2/auth/password/reset-confirm')
        .send({
          token: 'valid_token_32_character_string_here',
          newPassword: 'simple',
        });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('Protected endpoints authorization', () => {
    it('rejects /sessions endpoint without authorization header', async () => {
      const res = await request(app).get('/api/v2/auth/sessions');
      expect(res.status).toBe(401);
    });

    it('rejects /mfa/setup endpoint without authorization header', async () => {
      const res = await request(app).post('/api/v2/auth/mfa/setup').send({});
      expect(res.status).toBe(401);
    });
  });
});
