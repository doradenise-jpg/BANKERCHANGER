import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import authRouter from '../../src/routes/auth.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';
import { AppError } from '../../src/utils/AppError';

const mockIncrWithExpire = jest.fn();
const mockRedisTtl = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockLogin = jest.fn();
let loginBackoffTtl = 0;

jest.mock('../../src/services/redis-lua', () => ({
  incrWithExpire: (...args: unknown[]) => mockIncrWithExpire(...args),
}));

jest.mock('../../src/services/cache.service', () => ({
  redis: {
    ttl: (...args: unknown[]) => mockRedisTtl(...args),
    set: (...args: unknown[]) => mockRedisSet(...args),
    del: (...args: unknown[]) => mockRedisDel(...args),
  },
}));

jest.mock('../../src/services/auth.service', () => ({
  login: (...args: unknown[]) => mockLogin(...args),
}));

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use(errorMiddleware);

describe('POST /auth/login protections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loginBackoffTtl = 0;
    mockIncrWithExpire.mockImplementation(async (_redis: unknown, key: string) => {
      const priorCount = mockIncrWithExpire.mock.calls.filter((call) => call[1] === key).length;
      return priorCount;
    });
    mockRedisTtl.mockImplementation(async (key: string) =>
      key.startsWith('auth:login:backoff:') ? loginBackoffTtl : 900,
    );
    mockRedisSet.mockImplementation(async (key: string, _value: string, _expiry: string, seconds: number) => {
      if (key.startsWith('auth:login:backoff:')) loginBackoffTtl = seconds;
      return 'OK';
    });
    mockRedisDel.mockResolvedValue(2);
    mockLogin.mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' });
  });

  it('returns 429 with Retry-After on the 11th request from one IP in 15 minutes', async () => {
    const responses = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      responses.push(
        await request(app).post('/auth/login').send({ email: 'user@example.com', password: 'password' }),
      );
    }

    expect(responses.slice(0, 10).every((response) => response.status === 200)).toBe(true);
    expect(responses[10].status).toBe(429);
    expect(responses[10].headers['retry-after']).toBe('900');
    expect(mockLogin).toHaveBeenCalledTimes(10);
    expect(mockIncrWithExpire.mock.calls[0][1]).toMatch(/^rl:auth:login:15m:/);
    expect(mockIncrWithExpire.mock.calls[0][2]).toBe(900);
  });

  it('backs off after five failed attempts for the same email', async () => {
    mockLogin.mockRejectedValue(new AppError(401, 'Invalid credentials'));

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request(app)
        .post('/auth/login')
        .send({ email: 'user@example.com', password: 'wrong-password' });
      expect(response.status).toBe(401);
    }

    expect(mockRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:login:backoff:/),
      '1',
      'EX',
      30,
    );

    const blocked = await request(app)
      .post('/auth/login')
      .send({ email: 'user@example.com', password: 'wrong-password' });

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('30');
    expect(mockLogin).toHaveBeenCalledTimes(5);
  });
});