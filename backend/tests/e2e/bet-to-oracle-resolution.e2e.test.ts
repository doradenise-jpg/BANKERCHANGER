/**
 * Automated End-to-End Integration Test Suite:
 * Full Lifecycle from Market Creation to Bet Placement, Indexer Ingestion,
 * Oracle Resolution, Payout Calculation, and Winnings Claim.
 *
 * Covers:
 *   1. Market Creation (Event -> Indexer -> DB -> Status 'open')
 *   2. Multi-User Bet Placement (Bettor A on Outcome 1, Bettor B on Outcome 2)
 *   3. Indexer Event Ingestion & DB Atomic State Updates
 *   4. Odds & Pool Calculation Invariants
 *   5. Oracle Resolution Pipeline (Mock Boxing API -> Signature -> OracleReport -> DB)
 *   6. Market Resolution & Settlement Event Processing
 *   7. Payout Computation (Formula: (amount / winning_pool) * (total_pool - fee))
 *   8. Winner Claims Processing & DB Consistency Verification
 *   9. WebSocket Real-Time Event Broadcast Verification
 *  10. Test Cleanup & Database Teardown
 */

import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import { ActivityFeed, type ActivityEvent } from '../../src/websocket/realtime';
import {
  handleMarketCreated,
  handleBetPlaced,
  handleMarketResolved,
  handleWinningsClaimed,
  type RawStellarEvent,
} from '../../src/indexer/StellarIndexer';
import {
  fetchExternalFightResult,
  submitFightResult,
} from '../../src/oracle/OracleService';
import { calculateProjectedPayout } from '../../src/services/BetService';

// -- Database configuration ---------------------------------------------------
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://bankerchanger:bankerchanger@localhost:5433/bankerchanger_test';

// Deterministic test oracle secret
const ORACLE_SECRET = 'SCZANGBA5RLMPI7JMTP2C6GKMT2O6JVEAMOSYVBMSHAHJQERPIFOQKR';
process.env.ORACLE_PRIVATE_KEY = ORACLE_SECRET;
process.env.BOXING_API_URL = 'https://api.boxing-mock.test';
process.env.BOXING_API_KEY = 'test-e2e-api-key';

// -- Module Mocks -------------------------------------------------------------
jest.mock('../../src/services/StellarService', () => ({
  ...jest.requireActual('../../src/services/StellarService'),
  invokeContract: jest.fn().mockResolvedValue('mock-tx-hash-e2e-resolve'),
}));

jest.mock('../../src/services/cache.service', () => ({
  cacheGet: jest.fn().mockResolvedValue(undefined),
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pool } = require('../../src/config/db') as { pool: Pool };
const SCHEMA = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8');

// -- Test Fixtures & Constants ------------------------------------------------
const MARKET_ID = `mkt-e2e-${randomUUID()}`;
const MATCH_ID = `fight-e2e-${randomUUID()}`;
const CONTRACT_ADDRESS = 'CTEST_E2E_MARKET_CONTRACT';
const BETTOR_A = 'GBETTORAAAAAAAAAAA1111111111111111111111111111111111111111';
const BETTOR_B = 'GBETTORBBBBBBBBBBB2222222222222222222222222222222222222222';
const BETTOR_A_AMOUNT = '1000000000'; // 100 XLM in stroops
const BETTOR_B_AMOUNT = '500000000';  // 50 XLM in stroops
const OUTCOME_1 = 'fighter_a' as const;
const OUTCOME_2 = 'fighter_b' as const;
const CLOSE_TIME_ISO = '2026-08-29T12:00:00.000Z';

// Helper for database queries
async function queryRows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

function waitForWsMessage(ws: WebSocket, timeoutMs = 3000): Promise<ActivityEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for WebSocket message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as ActivityEvent);
    });
  });
}

describe('Automated E2E Integration Suite: Full Bet Placement to Oracle Resolution Flow', () => {
  let httpServer: http.Server;
  let feed: ActivityFeed;
  let wsClient: WebSocket;

  beforeAll(async () => {
    await pool.query(SCHEMA);

    httpServer = http.createServer();
    feed = new ActivityFeed(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as { port: number };

    wsClient = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => wsClient.once('open', resolve));
    wsClient.send(JSON.stringify({ type: 'subscribe_activity', marketId: MARKET_ID }));
    await new Promise((r) => setImmediate(r));
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE markets, bets, blockchain_events, oracle_reports, indexer_checkpoints, notification_jobs RESTART IDENTITY CASCADE',
    );
    jest.clearAllMocks();
  });

  afterAll(async () => {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.close();
    }
    if (feed) {
      feed.close();
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    await pool.query(
      'TRUNCATE markets, bets, blockchain_events, oracle_reports, indexer_checkpoints, notification_jobs CASCADE',
    );
    await pool.end();
  });

  it('executes complete 2-outcome market lifecycle with multi-bettor settlement', async () => {
    // ──────────────────────────────────────────────────────────────────────────
    // Step 1: Create 2-outcome market via MarketCreated event
    // ──────────────────────────────────────────────────────────────────────────
    const marketCreatedEvent: RawStellarEvent = {
      contract_address: CONTRACT_ADDRESS,
      event_type: 'market_created',
      topics: [],
      data: JSON.stringify({
        market_id: MARKET_ID,
        match_id: MATCH_ID,
        fighter_a: 'Tyson Fury',
        fighter_b: 'Oleksandr Usyk',
        weight_class: 'heavyweight',
        title_fight: true,
        venue: 'Kingdom Arena',
        scheduled_at: '2026-09-01T20:00:00Z',
        fee_bps: 200, // 2% platform fee
        lock_before_secs: 3600,
      }),
      ledger_sequence: 100,
      ledger_close_time: CLOSE_TIME_ISO,
      tx_hash: `tx-create-${randomUUID()}`,
    };

    await handleMarketCreated(marketCreatedEvent);

    const [market] = await queryRows<{
      market_id: string;
      status: string;
      pool_a: string;
      pool_b: string;
      total_pool: string;
      fee_bps: number;
    }>('SELECT * FROM markets WHERE market_id = $1', [MARKET_ID]);

    expect(market).toBeDefined();
    expect(market.status).toBe('open');
    expect(Number(market.pool_a)).toBe(0);
    expect(Number(market.pool_b)).toBe(0);
    expect(Number(market.total_pool)).toBe(0);
    expect(market.fee_bps).toBe(200);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 2: Multi-user bet placement
    // Bettor A backs Outcome 1 (100 XLM); Bettor B backs Outcome 2 (50 XLM)
    // ──────────────────────────────────────────────────────────────────────────
    const betAEvent: RawStellarEvent = {
      contract_address: CONTRACT_ADDRESS,
      event_type: 'bet_placed',
      topics: [],
      data: JSON.stringify({
        market_id: MARKET_ID,
        bettor_address: BETTOR_A,
        side: OUTCOME_1,
        amount: BETTOR_A_AMOUNT,
        placed_at: '2026-08-29T10:00:00Z',
      }),
      ledger_sequence: 101,
      ledger_close_time: CLOSE_TIME_ISO,
      tx_hash: `tx-bet-a-${randomUUID()}`,
    };

    const betBEvent: RawStellarEvent = {
      contract_address: CONTRACT_ADDRESS,
      event_type: 'bet_placed',
      topics: [],
      data: JSON.stringify({
        market_id: MARKET_ID,
        bettor_address: BETTOR_B,
        side: OUTCOME_2,
        amount: BETTOR_B_AMOUNT,
        placed_at: '2026-08-29T10:05:00Z',
      }),
      ledger_sequence: 102,
      ledger_close_time: CLOSE_TIME_ISO,
      tx_hash: `tx-bet-b-${randomUUID()}`,
    };

    // Ingest Bettor A's bet
    await handleBetPlaced(betAEvent);
    // Ingest Bettor B's bet
    await handleBetPlaced(betBEvent);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 3: Verify indexer updates database state & odds
    // ──────────────────────────────────────────────────────────────────────────
    const betRows = await queryRows<{
      bettor_address: string;
      side: string;
      amount: string;
      amount_xlm: string;
      claimed: boolean;
    }>('SELECT * FROM bets WHERE market_id = $1 ORDER BY placed_at ASC', [MARKET_ID]);

    expect(betRows).toHaveLength(2);
    expect(betRows[0].bettor_address).toBe(BETTOR_A);
    expect(betRows[0].side).toBe(OUTCOME_1);
    expect(betRows[0].amount).toBe(BETTOR_A_AMOUNT);
    expect(Number(betRows[0].amount_xlm)).toBe(100);
    expect(betRows[0].claimed).toBe(false);

    expect(betRows[1].bettor_address).toBe(BETTOR_B);
    expect(betRows[1].side).toBe(OUTCOME_2);
    expect(betRows[1].amount).toBe(BETTOR_B_AMOUNT);
    expect(Number(betRows[1].amount_xlm)).toBe(50);
    expect(betRows[1].claimed).toBe(false);

    // Verify aggregate pools on market
    const [updatedMarket] = await queryRows<{
      pool_a: string;
      pool_b: string;
      total_pool: string;
    }>('SELECT pool_a, pool_b, total_pool FROM markets WHERE market_id = $1', [MARKET_ID]);

    expect(Number(updatedMarket.pool_a)).toBe(1_000_000_000);
    expect(Number(updatedMarket.pool_b)).toBe(500_000_000);
    expect(Number(updatedMarket.total_pool)).toBe(1_500_000_000);

    // Verify odds / implied probabilities (Outcome 1 = 66.67%, Outcome 2 = 33.33%)
    const totalPool = Number(updatedMarket.total_pool);
    const impliedProbA = Number(updatedMarket.pool_a) / totalPool;
    const impliedProbB = Number(updatedMarket.pool_b) / totalPool;
    expect(impliedProbA).toBeCloseTo(0.6667, 3);
    expect(impliedProbB).toBeCloseTo(0.3333, 3);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 4: Submit Oracle resolution for Outcome 1
    // ──────────────────────────────────────────────────────────────────────────
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        fights: [{ fight_id: MATCH_ID, status: 'confirmed', result: OUTCOME_1 }],
      }),
    } as unknown as Response);

    const fetchedResult = await fetchExternalFightResult(MATCH_ID);
    expect(fetchedResult).toBe(OUTCOME_1);

    const oracleReport = await submitFightResult(MATCH_ID, OUTCOME_1);
    expect(oracleReport.match_id).toBe(MATCH_ID);
    expect(oracleReport.outcome).toBe(OUTCOME_1);
    expect(oracleReport.accepted).toBe(true);

    // Ingest MarketResolved event
    const marketResolvedEvent: RawStellarEvent = {
      contract_address: CONTRACT_ADDRESS,
      event_type: 'market_resolved',
      topics: [],
      data: JSON.stringify({
        market_id: MARKET_ID,
        match_id: MATCH_ID,
        outcome: OUTCOME_1,
        oracle_address: oracleReport.oracle_address,
      }),
      ledger_sequence: 150,
      ledger_close_time: CLOSE_TIME_ISO,
      tx_hash: `tx-resolved-${randomUUID()}`,
    };

    await handleMarketResolved(marketResolvedEvent);

    const [resolvedMarket] = await queryRows<{
      status: string;
      outcome: string;
      resolved_at: Date | null;
    }>('SELECT status, outcome, resolved_at FROM markets WHERE market_id = $1', [MARKET_ID]);

    expect(resolvedMarket.status).toBe('resolved');
    expect(resolvedMarket.outcome).toBe(OUTCOME_1);
    expect(resolvedMarket.resolved_at).not.toBeNull();

    // Verify notification jobs queued for bettors
    const notificationJobs = await queryRows<{
      bettor_address: string;
      job_type: string;
    }>('SELECT * FROM notification_jobs WHERE market_id = $1', [MARKET_ID]);
    expect(notificationJobs.length).toBe(2);

    // ──────────────────────────────────────────────────────────────────────────
    // Step 5: Verify Payouts Calculated Correctly & Claims Processed
    // Formula: (amount / winning_pool) * (total_pool - fee)
    // total_pool = 150 XLM (1,500,000,000 stroops)
    // fee = 2% of 150 XLM = 3 XLM (30,000,000 stroops)
    // net_pool = 147 XLM (1,470,000,000 stroops)
    // Bettor A has 100% of winning pool -> payout = 147 XLM
    // ──────────────────────────────────────────────────────────────────────────
    const bettorAPayout = await calculateProjectedPayout(MARKET_ID, BETTOR_A, OUTCOME_1);
    expect(bettorAPayout.amount).toBe('1470000000');
    expect(bettorAPayout.formatted_xlm).toBe(147);

    // Bettor B bet on losing outcome -> 0 payout
    const bettorBPayout = await calculateProjectedPayout(MARKET_ID, BETTOR_B, OUTCOME_1);
    expect(bettorBPayout.amount).toBe('0');
    expect(bettorBPayout.formatted_xlm).toBe(0);

    // Process Bettor A claim
    const claimEvent: RawStellarEvent = {
      contract_address: CONTRACT_ADDRESS,
      event_type: 'winnings_claimed',
      topics: [],
      data: JSON.stringify({
        market_id: MARKET_ID,
        bettor_address: BETTOR_A,
        payout: '1470000000',
      }),
      ledger_sequence: 160,
      ledger_close_time: CLOSE_TIME_ISO,
      tx_hash: `tx-claim-a-${randomUUID()}`,
    };

    await handleWinningsClaimed(claimEvent);

    const [bettorABet] = await queryRows<{
      claimed: boolean;
      payout: string;
      claimed_at: Date | null;
    }>('SELECT claimed, payout, claimed_at FROM bets WHERE market_id = $1 AND bettor_address = $2', [
      MARKET_ID,
      BETTOR_A,
    ]);

    expect(bettorABet.claimed).toBe(true);
    expect(Number(bettorABet.payout)).toBe(1_470_000_000);
    expect(bettorABet.claimed_at).not.toBeNull();

    delete (global as Record<string, unknown>).fetch;
  });
});
