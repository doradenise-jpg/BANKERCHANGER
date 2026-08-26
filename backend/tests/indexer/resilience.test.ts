/**
 * Tests for indexer polling resilience: exponential backoff, re-org /
 * missing-ledger handling, and WebSocket activity streaming on ingestion.
 *
 * Mirrors the mocking idiom used in tests/services/StellarService.test.ts —
 * `@stellar/stellar-sdk`'s rpc.Server is replaced with a mock whose methods
 * are proxied through a global so the (hoisted) jest.mock factory can reach
 * per-test mock functions declared afterwards.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Shared mock state (see StellarService.test.ts for why `global` is used) ─
const rpcMock = {
  getEvents: jest.fn<() => Promise<unknown>>(),
  getLatestLedger: jest.fn<() => Promise<unknown>>(),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk') as Record<string, unknown>;
  return {
    ...actual,
    rpc: {
      ...(actual.rpc as Record<string, unknown>),
      Server: jest.fn().mockImplementation(() => ({
        getEvents: (...a: unknown[]) => (global as any).__indexerRpcMock.getEvents(...a),
        getLatestLedger: (...a: unknown[]) => (global as any).__indexerRpcMock.getLatestLedger(...a),
      })),
    },
  };
});
(global as any).__indexerRpcMock = rpcMock;

jest.mock('../../src/config/db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    }),
  },
}));

jest.mock('../../src/services/cache.service', () => ({
  cacheDeletePattern: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/StellarService', () => ({
  subscribeToContractEvents: jest.fn(),
  fetchHistoricalEvents: jest.fn(),
}));

const activityFeedMock = { publish: jest.fn() };
jest.mock('../../src/websocket/realtime', () => ({
  getActivityFeedIfInitialized: jest.fn(() => activityFeedMock),
}));

import {
  calculatePollBackoff,
  isLedgerUnavailableError,
  processLedger,
  handleBetPlaced,
  handleMarketResolved,
  handleMarketCancelled,
} from '../../src/indexer/StellarIndexer';
import type { RawStellarEvent } from '../../src/indexer/StellarIndexer';
import { getActivityFeedIfInitialized } from '../../src/websocket/realtime';

function makeEvent(overrides: Partial<RawStellarEvent> = {}): RawStellarEvent {
  return {
    contract_address: 'CTEST',
    event_type: 'bet_placed',
    topics: [],
    data: JSON.stringify({ market_id: 'm1', bettor_address: 'GABC', side: 'fighter_a', amount: 1000 }),
    ledger_sequence: 1000,
    ledger_close_time: new Date().toISOString(),
    tx_hash: 'tx-1',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('calculatePollBackoff', () => {
  it('grows with consecutive failures', () => {
    // Jitter is [0.5x, 1x] of the capped exponential value, so compare ranges.
    const first = calculatePollBackoff(1); // base 1000ms, capped range [500, 1000]
    const third = calculatePollBackoff(3); // base 4000ms, capped range [2000, 4000]
    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThanOrEqual(1000);
    expect(third).toBeGreaterThanOrEqual(2000);
    expect(third).toBeLessThanOrEqual(4000);
  });

  it('caps at the maximum backoff regardless of how many failures occur', () => {
    const huge = calculatePollBackoff(50);
    expect(huge).toBeLessThanOrEqual(60_000);
    expect(huge).toBeGreaterThanOrEqual(30_000);
  });
});

describe('isLedgerUnavailableError', () => {
  it('recognizes RPC retention/out-of-range style errors', () => {
    expect(isLedgerUnavailableError(new Error('start ledger sequence is outside the range for this node'))).toBe(true);
    expect(isLedgerUnavailableError(new Error('ledger not found'))).toBe(true);
    expect(isLedgerUnavailableError(new Error('ledger 12345 is before the oldest ledger in the retention window'))).toBe(true);
  });

  it('does not misclassify unrelated errors', () => {
    expect(isLedgerUnavailableError(new Error('connection timed out'))).toBe(false);
    expect(isLedgerUnavailableError(new Error('database connection refused'))).toBe(false);
  });
});

describe('processLedger — missing ledger sequences', () => {
  it('resolves cleanly (skips) when the RPC node reports the ledger is unavailable', async () => {
    rpcMock.getEvents.mockRejectedValue(new Error('start ledger is outside the range for this node'));
    await expect(processLedger(42)).resolves.toBeUndefined();
  });

  it('propagates genuine errors so the caller can back off and retry', async () => {
    rpcMock.getEvents.mockRejectedValue(new Error('ECONNRESET'));
    await expect(processLedger(42)).rejects.toThrow('ECONNRESET');
  });
});

describe('WebSocket activity streaming on event ingestion', () => {
  it('publishes a trade event when a bet is placed', async () => {
    await handleBetPlaced(makeEvent());
    expect(activityFeedMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'trade', marketId: 'm1', side: 'fighter_a', sharesAmount: 1000 }),
    );
  });

  it('publishes a resolved event when a market resolves', async () => {
    const event = makeEvent({
      event_type: 'market_resolved',
      data: JSON.stringify({ market_id: 'm1', outcome: 'fighter_a' }),
    });
    await handleMarketResolved(event);
    expect(activityFeedMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resolved', marketId: 'm1', winningOutcomeId: 'fighter_a' }),
    );
  });

  it('publishes a cancelled event when a market is cancelled', async () => {
    const event = makeEvent({
      event_type: 'market_cancelled',
      data: JSON.stringify({ market_id: 'm1' }),
    });
    await handleMarketCancelled(event);
    expect(activityFeedMock.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cancelled', marketId: 'm1' }),
    );
  });

  it('does not throw when no activity feed has been initialised', async () => {
    (getActivityFeedIfInitialized as jest.Mock).mockReturnValueOnce(null as never);
    await expect(handleBetPlaced(makeEvent())).resolves.toBeUndefined();
  });
});
