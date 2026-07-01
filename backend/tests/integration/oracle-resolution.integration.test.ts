/**
 * Integration test: Oracle Resolution Pipeline
 *
 * Exercises the full flow:
 *   1. Mocked external boxing API returns a confirmed fight outcome
 *   2. fetchExternalFightResult() reads the mock
 *   3. submitFightResult() records the OracleReport in the DB and calls invokeContract (mocked)
 *   4. handleMarketResolved() (indexer) updates the market row in the DB
 *   5. ActivityFeed.publish() broadcasts the "resolved" WebSocket event
 *
 * Requires a running PostgreSQL instance:
 *   DATABASE_URL=postgresql://boxmeout:boxmeout@localhost:5433/boxmeout_test
 *   docker compose --profile test up -d postgres-test
 *
 * Redis and invokeContract are mocked so no live Stellar network is needed.
 */

import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import { ActivityFeed, type ActivityEvent } from '../../src/websocket/realtime';
import {
  fetchExternalFightResult,
  submitFightResult,
} from '../../src/oracle/OracleService';
import { handleMarketResolved } from '../../src/indexer/StellarIndexer';
import type { RawStellarEvent } from '../../src/indexer/StellarIndexer';

// -- Environment --------------------------------------------------------------

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://boxmeout:boxmeout@localhost:5433/boxmeout_test';

// Deterministic oracle keypair (Stellar testnet-format, never used on mainnet)
const ORACLE_SECRET = 'SCZANGBA5RLMPI7JMTP2C6GKMT2O6JVEAMOSYVBMSHAHJQERPIFOQKR';
process.env.ORACLE_PRIVATE_KEY = ORACLE_SECRET;

// Boxing API env vars (values don't matter — fetch is mocked below)
process.env.BOXING_API_URL = 'https://api.boxing-mock.test';
process.env.BOXING_API_KEY = 'test-api-key';

// Disable alert webhook
delete process.env.ALERT_WEBHOOK_URL;

// -- Module mocks -------------------------------------------------------------

// Mock invokeContract so no real Stellar submission happens
jest.mock('../../src/services/StellarService', () => ({
  ...jest.requireActual('../../src/services/StellarService'),
  invokeContract: jest.fn().mockResolvedValue('mock-tx-hash-oracle-resolve'),
}));

// Mock Redis so no real Redis connection is needed
jest.mock('../../src/services/cache.service', () => ({
  cacheGet: jest.fn().mockResolvedValue(undefined), // cache miss => always fetch
  cacheSet: jest.fn().mockResolvedValue(undefined),
  cacheDeletePattern: jest.fn().mockResolvedValue(undefined),
  redis: {
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  },
}));

// -- DB pool -------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pool } = require('../../src/config/db') as { pool: Pool };

const SCHEMA = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8');

// -- Fixtures ------------------------------------------------------------------

const MARKET_ID = `mkt-oracle-${randomUUID()}`;
const MATCH_ID = `fight-oracle-${randomUUID()}`;
const CONTRACT_ADDRESS = 'CTEST_ORACLE_CONTRACT';
const ORACLE_OUTCOME = 'fighter_a' as const;

// Deterministic timestamp
const FROZEN_ISO = '2026-06-30T10:00:00.000Z';

// -- Helpers -------------------------------------------------------------------

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

function waitForWsMessage(ws: WebSocket, timeoutMs = 2000): Promise<ActivityEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timeout waiting for WebSocket message')),
      timeoutMs,
    );
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as ActivityEvent);
    });
  });
}

// -- Setup / Teardown ----------------------------------------------------------

beforeAll(async () => {
  await pool.query(SCHEMA);
});

beforeEach(async () => {
  await pool.query(
    'TRUNCATE markets, bets, blockchain_events, oracle_reports, indexer_checkpoints, notification_jobs RESTART IDENTITY CASCADE',
  );

  // Seed a market the oracle pipeline will resolve
  await pool.query(
    `INSERT INTO markets
       (market_id, contract_address, match_id, fighter_a, fighter_b,
        weight_class, title_fight, venue, scheduled_at, status, ledger_sequence)
     VALUES ($1,$2,$3,$4,$5,'heavyweight',false,'MSG', NOW() - INTERVAL '2 hours','open',1000)`,
    [MARKET_ID, CONTRACT_ADDRESS, MATCH_ID, 'Ali', 'Frazier'],
  );

  jest.clearAllMocks();
});

afterAll(async () => {
  await pool.query(
    'TRUNCATE markets, bets, blockchain_events, oracle_reports, indexer_checkpoints, notification_jobs CASCADE',
  );
  await pool.end();
});

// -- Tests ---------------------------------------------------------------------

describe('Oracle Resolution Pipeline', () => {
  it('resolves a market end-to-end: DB status=resolved, outcome correct, resolved_at populated, WS event published', async () => {
    // 1. Mock external boxing API
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        fights: [{ fight_id: MATCH_ID, status: 'confirmed', result: ORACLE_OUTCOME }],
      }),
    } as unknown as Response);

    global.fetch = mockFetch;

    // 2. Set up WebSocket server + ActivityFeed
    const httpServer = http.createServer();
    const feed = new ActivityFeed(httpServer);

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as { port: number };

    const wsClient = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => wsClient.once('open', resolve));
    wsClient.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    await new Promise((r) => setImmediate(r));

    // Prime the WS message listener before the event is published
    const wsMessagePromise = waitForWsMessage(wsClient);

    try {
      // 3. Fetch confirmed fight result from mocked external API
      const fetchedOutcome = await fetchExternalFightResult(MATCH_ID);
      expect(fetchedOutcome).toBe(ORACLE_OUTCOME);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl: string = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain(encodeURIComponent(MATCH_ID));

      // 4. Submit fight result — writes OracleReport row, calls invokeContract
      const { invokeContract } = require('../../src/services/StellarService') as {
        invokeContract: jest.Mock;
      };

      const oracleReport = await submitFightResult(MATCH_ID, ORACLE_OUTCOME);

      expect(invokeContract).toHaveBeenCalledTimes(1);
      expect(invokeContract.mock.calls[0][0]).toBe(CONTRACT_ADDRESS);
      expect(invokeContract.mock.calls[0][1]).toBe('resolve_market');

      expect(oracleReport.match_id).toBe(MATCH_ID);
      expect(oracleReport.outcome).toBe(ORACLE_OUTCOME);
      expect(oracleReport.accepted).toBe(true);
      expect(oracleReport.tx_hash).toBe('mock-tx-hash-oracle-resolve');

      // 5. Simulate the indexer receiving the on-chain MarketResolved event
      const resolvedEvent: RawStellarEvent = {
        contract_address: CONTRACT_ADDRESS,
        event_type: 'market_resolved',
        topics: [],
        data: JSON.stringify({
          market_id: MARKET_ID,
          match_id: MATCH_ID,
          outcome: ORACLE_OUTCOME,
          oracle_address: oracleReport.oracle_address,
        }),
        ledger_sequence: 2000,
        ledger_close_time: FROZEN_ISO,
        tx_hash: `tx-resolved-${randomUUID()}`,
      };

      await handleMarketResolved(resolvedEvent);

      // 6. DB assertions
      const [marketRow] = await q<{
        status: string;
        outcome: string;
        resolved_at: Date | null;
        oracle_used: string;
      }>('SELECT status, outcome, resolved_at, oracle_used FROM markets WHERE market_id = $1', [
        MARKET_ID,
      ]);

      expect(marketRow.status).toBe('resolved');
      expect(marketRow.outcome).toBe(ORACLE_OUTCOME);
      expect(marketRow.resolved_at).not.toBeNull();
      expect(new Date(marketRow.resolved_at!).toISOString()).toBe(FROZEN_ISO);

      // OracleReport row is accepted
      const oracleRows = await q<{ accepted: boolean; outcome: string }>(
        'SELECT accepted, outcome FROM oracle_reports WHERE match_id = $1 AND accepted = TRUE',
        [MATCH_ID],
      );
      expect(oracleRows.length).toBeGreaterThanOrEqual(1);
      expect(oracleRows[0].outcome).toBe(ORACLE_OUTCOME);

      // 7. WebSocket assertion — publish "resolved" event
      const resolvedWsEvent: ActivityEvent = {
        type: 'resolved',
        marketId: MARKET_ID,
        winningOutcomeId: ORACLE_OUTCOME,
      };

      feed.publish(resolvedWsEvent);

      const receivedWsMsg = await wsMessagePromise;

      expect(receivedWsMsg.type).toBe('resolved');
      expect((receivedWsMsg as typeof resolvedWsEvent).marketId).toBe(MARKET_ID);
      expect((receivedWsMsg as typeof resolvedWsEvent).winningOutcomeId).toBe(ORACLE_OUTCOME);
      expect(receivedWsMsg).toEqual(resolvedWsEvent);
    } finally {
      wsClient.close();
      await new Promise<void>((resolve) => {
        feed.close();
        httpServer.close(() => resolve());
      });
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('fetchExternalFightResult returns null when fight is not yet confirmed', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        fights: [{ fight_id: MATCH_ID, status: 'pending', result: null }],
      }),
    } as unknown as Response);

    try {
      const result = await fetchExternalFightResult(MATCH_ID);
      expect(result).toBeNull();
    } finally {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('handleMarketResolved leaves market in resolved state on duplicate event', async () => {
    const txHash = `tx-idem-${randomUUID()}`;
    const resolvedEvent: RawStellarEvent = {
      contract_address: CONTRACT_ADDRESS,
      event_type: 'market_resolved',
      topics: [],
      data: JSON.stringify({
        market_id: MARKET_ID,
        match_id: MATCH_ID,
        outcome: ORACLE_OUTCOME,
        oracle_address: 'GTEST',
      }),
      ledger_sequence: 3000,
      ledger_close_time: FROZEN_ISO,
      tx_hash: txHash,
    };

    await handleMarketResolved(resolvedEvent);
    // Second event with different tx_hash (duplicate scenario)
    await handleMarketResolved({
      ...resolvedEvent,
      tx_hash: `tx-idem2-${randomUUID()}`,
      ledger_close_time: '2026-06-30T11:00:00.000Z',
    });

    const [marketRow] = await q<{ status: string; outcome: string }>(
      'SELECT status, outcome FROM markets WHERE market_id = $1',
      [MARKET_ID],
    );
    expect(marketRow.status).toBe('resolved');
    expect(marketRow.outcome).toBe(ORACLE_OUTCOME);
  });
});
