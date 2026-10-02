import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';
import oracleGroup5Router from '../../src/routes/oracleGroup5.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/oracle', oracleGroup5Router);
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

jest.mock('../../src/config/env', () => ({
  getEnv: jest.fn().mockReturnValue({
    ADMIN_JWT_SECRET: 'test-admin-secret-key-32-chars-long!',
    JWT_SECRET: 'test-secret',
    NODE_ENV: 'test',
  }),
}));

const { pool } = require('../../src/config/db');

describe('API Module Group 5: Oracle Results & Dispute Resolution Endpoints', () => {
  const validOracleKey = 'default-oracle-secret-key';
  const oracleKeypair = Keypair.random();
  const validStellarAddress = oracleKeypair.publicKey();
  const validPublicKey = oracleKeypair.rawPublicKey().toString('hex');
  const adminSecret = 'test-admin-secret-key-32-chars-long!';
  const validAdminToken = jwt.sign(
    { sub: 'admin-1', role: 'admin', type: 'access' },
    adminSecret,
    { expiresIn: '1h' }
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (pool.connect as jest.Mock).mockResolvedValue(mockClient);
    process.env.ORACLE_API_KEY = validOracleKey;
  });

  describe('POST /api/v2/oracle/report', () => {
    const reportedAt = '2026-01-01T12:00:00.000Z';
    const matchId = 'match_123';
    const messageMatchIdBytes = Buffer.from(matchId, 'utf8');
    const messageLength = Buffer.alloc(4);
    messageLength.writeUInt32BE(messageMatchIdBytes.length, 0);
    const messageTimestamp = Buffer.alloc(8);
    messageTimestamp.writeBigInt64BE(BigInt(new Date(reportedAt).getTime()));
    const signedMessage = Buffer.concat([
      messageLength,
      messageMatchIdBytes,
      Buffer.from([0]),
      messageTimestamp,
    ]);
    const validReportPayload = {
      match_id: matchId,
      market_id: 'mkt_123',
      outcome: 'fighter_a',
      reported_at: reportedAt,
      oracle_address: validStellarAddress,
      signature: Buffer.from(oracleKeypair.sign(signedMessage)).toString('hex'),
    };

    it('submits report and resolves market successfully', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ public_key: validPublicKey }] });
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ market_id: 'mkt_123', status: 'open' }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: 1, ...validReportPayload }],
        })
        .mockResolvedValueOnce({}) // UPDATE markets
        .mockResolvedValueOnce({}); // COMMIT

      const res = await request(app)
        .post('/api/v2/oracle/report')
        .set('X-Oracle-Key', validOracleKey)
        .send(validReportPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.outcome).toBe('fighter_a');
    });

    it('rejects a forged report with 403 before writing to the database', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ public_key: validPublicKey }] });

      const res = await request(app)
        .post('/api/v2/oracle/report')
        .set('X-Oracle-Key', validOracleKey)
        .send({ ...validReportPayload, signature: 'a'.repeat(128) });

      expect(res.status).toBe(403);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('rejects a missing signature with 403', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ public_key: validPublicKey }] });

      const res = await request(app)
        .post('/api/v2/oracle/report')
        .set('X-Oracle-Key', validOracleKey)
        .send({ ...validReportPayload, signature: undefined });

      expect(res.status).toBe(403);
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('rejects request without X-Oracle-Key with 401', async () => {
      const res = await request(app)
        .post('/api/v2/oracle/report')
        .send(validReportPayload);

      expect(res.status).toBe(401);
    });

    it('rejects a malformed signature with 403', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rows: [{ public_key: validPublicKey }] });

      const res = await request(app)
        .post('/api/v2/oracle/report')
        .set('X-Oracle-Key', validOracleKey)
        .send({ ...validReportPayload, signature: 'short_sig' });

      expect(res.status).toBe(403);
      expect(pool.connect).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v2/oracle/dispute', () => {
    it('flags dispute on resolved market', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ status: 'resolved' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 1, market_id: 'mkt_123', status: 'pending' }],
        });

      const res = await request(app)
        .post('/api/v2/oracle/dispute')
        .send({
          market_id: 'mkt_123',
          initiator_address: validStellarAddress,
          reason: 'Controversial decision requires official review',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('pending');
    });
  });

  describe('POST /api/v2/oracle/dispute/resolve', () => {
    it('resolves dispute with admin token and valid 6-digit TOTP', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ status: 'disputed' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const res = await request(app)
        .post('/api/v2/oracle/dispute/resolve')
        .set('Authorization', `Bearer ${validAdminToken}`)
        .send({
          market_id: 'mkt_123',
          final_outcome: 'fighter_b',
          resolution_notes: 'Reviewed footage confirms knockdown ruling',
          totp_code: '123456',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.final_outcome).toBe('fighter_b');
    });
  });
});
