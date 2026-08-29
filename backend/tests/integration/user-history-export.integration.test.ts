import request from 'supertest';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import app from '../../src/index';

// Point the pool at test DB
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://bankerchanger:bankerchanger@localhost:5433/bankerchanger_test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pool } = require('../../src/config/db') as { pool: Pool };
const SCHEMA = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8');

const VALID_ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const OTHER_ADDRESS = 'GBRGSG3ARX6Y7DFBGS54T5A5Z5O5N5D5L5F5J5U5N5P5U525H5Y3Z5M5';
const INVALID_ADDRESS = 'INVALID_STELLAR_ADDRESS_123';

describe('GET /api/users/:address/history/export', () => {
  beforeAll(async () => {
    await pool.query(SCHEMA);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE markets, bets RESTART IDENTITY CASCADE');

    // Seed markets
    await pool.query(`
      INSERT INTO markets (market_id, contract_address, match_id, fighter_a, fighter_b, status, scheduled_at)
      VALUES 
        ('mkt-1', 'C_MKT_1', 'fight-1', 'Tyson Fury', 'Oleksandr Usyk', 'resolved', '2026-05-01T20:00:00Z'),
        ('mkt-2', 'C_MKT_2', 'fight-2', 'Anthony Joshua', 'Deontay Wilder', 'cancelled', '2026-06-01T20:00:00Z')
    `);

    // Seed bets for VALID_ADDRESS
    await pool.query(`
      INSERT INTO bets (market_id, bettor_address, side, amount, amount_xlm, placed_at, claimed, claimed_at, payout, tx_hash)
      VALUES
        ('mkt-1', '${VALID_ADDRESS}', 'fighter_a', '100000000', 10.0, '2026-05-01T18:00:00Z', true, '2026-05-01T22:00:00Z', '195000000', 'tx-bet-1'),
        ('mkt-2', '${VALID_ADDRESS}', 'fighter_b', '50000000', 5.0, '2026-06-01T17:00:00Z', true, '2026-06-01T21:00:00Z', '50000000', 'tx-bet-2')
    `);

    // Seed bet for OTHER_ADDRESS
    await pool.query(`
      INSERT INTO bets (market_id, bettor_address, side, amount, amount_xlm, placed_at, claimed, payout, tx_hash)
      VALUES
        ('mkt-1', '${OTHER_ADDRESS}', 'fighter_b', '20000000', 2.0, '2026-05-01T19:00:00Z', false, null, 'tx-other-1')
    `);
  });

  afterAll(async () => {
    await pool.query('TRUNCATE markets, bets CASCADE');
    await pool.end();
  });

  describe('Validation', () => {
    it('returns 400 for invalid Stellar address format', async () => {
      const res = await request(app).get(`/api/users/${INVALID_ADDRESS}/history/export`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid Stellar address/i);
    });

    it('returns 400 for unsupported format', async () => {
      const res = await request(app).get(`/api/users/${VALID_ADDRESS}/history/export?format=xml`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid format/i);
    });

    it('returns 400 for invalid startDate', async () => {
      const res = await request(app).get(`/api/users/${VALID_ADDRESS}/history/export?startDate=not-a-date`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid startDate/i);
    });

    it('returns 400 for invalid endDate', async () => {
      const res = await request(app).get(`/api/users/${VALID_ADDRESS}/history/export?endDate=not-a-date`);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid endDate/i);
    });

    it('returns 400 when startDate is after endDate', async () => {
      const res = await request(app).get(
        `/api/users/${VALID_ADDRESS}/history/export?startDate=2026-07-01T00:00:00Z&endDate=2026-06-01T00:00:00Z`
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/startDate cannot be after endDate/i);
    });
  });

  describe('CSV Export', () => {
    it('returns valid CSV stream with correct headers and ledger lines', async () => {
      const res = await request(app)
        .get(`/api/users/${VALID_ADDRESS}/history/export?format=csv`)
        .expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-history-/);

      const text = res.text;
      const lines = text.trim().split('\n');

      // CSV Header
      expect(lines[0]).toBe('Timestamp (UTC),Transaction Hash,Market ID,Market Title,Action Type,Outcome Picked,Amount (XLM),Payout (XLM),Net PnL (XLM)');

      // mkt-1 BET line
      expect(text).toContain('tx-bet-1');
      expect(text).toContain('Tyson Fury vs Oleksandr Usyk');
      expect(text).toContain('BET');

      // mkt-1 CLAIM line
      expect(text).toContain('CLAIM');
      expect(text).toContain('19.5');

      // mkt-2 REFUND line
      expect(text).toContain('tx-bet-2');
      expect(text).toContain('Anthony Joshua vs Deontay Wilder');
      expect(text).toContain('REFUND');
    });
  });

  describe('JSON Export', () => {
    it('returns valid JSON array stream with formatted records', async () => {
      const res = await request(app)
        .get(`/api/users/${VALID_ADDRESS}/history/export?format=json`)
        .expect(200);

      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-history-/);

      const data = JSON.parse(res.text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(4); // 2 bets + 2 claim/refund events

      const betRecord = data.find((d: any) => d.transactionHash === 'tx-bet-1' && d.actionType === 'BET');
      expect(betRecord).toBeDefined();
      expect(betRecord.marketTitle).toBe('Tyson Fury vs Oleksandr Usyk');
      expect(betRecord.amountXlm).toBe(10);
      expect(betRecord.payoutXlm).toBe(0);
      expect(betRecord.netPnlXlm).toBe(-10);

      const claimRecord = data.find((d: any) => d.transactionHash === 'tx-bet-1' && d.actionType === 'CLAIM');
      expect(claimRecord).toBeDefined();
      expect(claimRecord.payoutXlm).toBe(19.5);
      expect(claimRecord.netPnlXlm).toBe(9.5);

      const refundRecord = data.find((d: any) => d.transactionHash === 'tx-bet-2' && d.actionType === 'REFUND');
      expect(refundRecord).toBeDefined();
      expect(refundRecord.payoutXlm).toBe(5);
    });
  });

  describe('Date Filtering', () => {
    it('filters records within specified date range', async () => {
      const res = await request(app)
        .get(`/api/users/${VALID_ADDRESS}/history/export?format=json&startDate=2026-05-20T00:00:00Z&endDate=2026-06-15T00:00:00Z`)
        .expect(200);

      const data = JSON.parse(res.text);
      // Should only include mkt-2 records (placed in June 2026)
      expect(data.length).toBe(2);
      expect(data.every((d: any) => d.marketId === 'mkt-2')).toBe(true);
    });
  });
});
