import request from 'supertest';
import app from '../../src/index';
import { pool } from '../../src/config/db';
import { redis } from '../../src/config/redis';

describe('GET /health', () => {
  beforeAll(async () => {
    // Ensure connections are established
    await pool.query('SELECT 1');
    await redis.ping();
  });

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  it('should return 200 with all checks passing', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      db: 'connected',
      redis: 'connected',
      version: expect.any(String),
    });
    expect(response.body.dbPool).toBeDefined();
    expect(response.body.dbPool.totalCount).toBeGreaterThanOrEqual(0);
    expect(response.body.dbPool.idleCount).toBeGreaterThanOrEqual(0);
    expect(response.body.dbPool.waitingCount).toBeGreaterThanOrEqual(0);
  });

  it('should include version from package.json', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.version).toBe('0.1.0');
  });

  it('should return status ok when all services are healthy', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('should include database pool metrics', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.dbPool).toEqual({
      totalCount: expect.any(Number),
      idleCount: expect.any(Number),
      waitingCount: expect.any(Number),
    });
  });
});
