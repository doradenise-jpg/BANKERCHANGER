/**
 * Tests for the indexer polling-resilience work (batches 5-8):
 *  - exponential backoff instead of crashing on RPC errors
 *  - re-org / pruned-ledger handling in pollOnce()
 *  - broadcasting ingested events over the WebSocket ActivityFeed
 *
 * These tests do not require a running database or RPC node — the
 * Stellar RPC server, Postgres pool, cache service, and WebSocket feed
 * are all mocked.
 */

// ── Mock DB / cache / Stellar RPC before any module loads ───────────────────
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
  subscribeToContractEvents: jest.fn(() => () => {}),
  fetchHistoricalEvents: jest.fn(),
}));

jest.mock('../../src/websocket/realtime', () => ({
  tryGetActivityFeed: jest.fn(() => null),
}));

const mockServerInstance = {
  getLatestLedger: jest.fn(),
  getEvents: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => mockServerInstance),
    },
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────
import { pollOnce, calculateBackoff, processEvent } from '../../src/indexer/StellarIndexer';
import { pool } from '../../src/config/db';
import { tryGetActivityFeed } from '../../src/websocket/realtime';

const poolQueryMock = pool.query as jest.Mock;

describe('calculateBackoff', () => {
  it('produces a jittered range around 1s for the first failure', () => {
    const backoff = calculateBackoff(1);
    expect(backoff).toBeGreaterThanOrEqual(500);
    expect(backoff).toBeLessThanOrEqual(1000);
  });

  it('doubles roughly per failure and caps at 5 minutes', () => {
    const backoff = calculateBackoff(3);
    expect(backoff).toBeGreaterThanOrEqual(2000);
    expect(backoff).toBeLessThanOrEqual(4000);

    const capped = calculateBackoff(25);
    expect(capped).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(capped).toBeGreaterThanOrEqual(2.5 * 60 * 1000);
  });
});

describe('pollOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockServerInstance.getEvents.mockResolvedValue({ events: [] });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('advances through and checkpoints every new ledger', async () => {
    mockServerInstance.getLatestLedger.mockResolvedValue({ sequence: 103 });

    const result = await pollOnce(100);

    expect(result).toBe(103);
    expect(mockServerInstance.getEvents).toHaveBeenCalledTimes(3);
    const checkpointCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('indexer_checkpoints'),
    );
    expect(checkpointCalls).toHaveLength(3);
    expect(checkpointCalls.map(([, params]) => params[0])).toEqual([101, 102, 103]);
  });

  it('detects a re-org and resumes from the new tip without processing backward', async () => {
    mockServerInstance.getLatestLedger.mockResolvedValue({ sequence: 50 });

    const result = await pollOnce(100);

    expect(result).toBe(50);
    expect(mockServerInstance.getEvents).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Re-org detected'));
    const checkpointCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('indexer_checkpoints'),
    );
    expect(checkpointCalls).toHaveLength(1);
    expect(checkpointCalls[0][1][0]).toBe(50);
  });

  it('skips a pruned/out-of-range ledger instead of blocking forever', async () => {
    mockServerInstance.getLatestLedger.mockResolvedValue({ sequence: 103 });
    mockServerInstance.getEvents
      .mockRejectedValueOnce(new Error('startLedger 101 is before oldest ledger 150'))
      .mockResolvedValue({ events: [] });

    const result = await pollOnce(100);

    expect(result).toBe(103);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Ledger 101 unavailable'),
      expect.any(Error),
    );
  });

  it('propagates a real RPC failure without checkpointing the failed ledger', async () => {
    mockServerInstance.getLatestLedger.mockResolvedValue({ sequence: 102 });
    mockServerInstance.getEvents.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(pollOnce(100)).rejects.toThrow('ECONNREFUSED');

    const checkpointCalls = poolQueryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('indexer_checkpoints'),
    );
    expect(checkpointCalls).toHaveLength(0);
  });
});

describe('processEvent WebSocket broadcast', () => {
  const publishMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (tryGetActivityFeed as jest.Mock).mockReturnValue({ publish: publishMock });
  });

  function makeEvent(type: string, data: Record<string, unknown>) {
    return {
      contract_address: 'CTEST',
      event_type: type,
      topics: [],
      data: JSON.stringify(data),
      ledger_sequence: 1000,
      ledger_close_time: new Date().toISOString(),
      tx_hash: `tx-${type}-${Math.random()}`,
    };
  }

  it('publishes a trade event for bet_placed', async () => {
    await processEvent(makeEvent('bet_placed', { market_id: 'm1', side: 'fighter_a', amount: '500' }));

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'trade', marketId: 'm1', side: 'fighter_a', sharesAmount: 500 }),
    );
  });

  it('publishes a resolved event for market_resolved', async () => {
    await processEvent(makeEvent('market_resolved', { market_id: 'm1', outcome: 'fighter_a' }));

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resolved', marketId: 'm1', winningOutcomeId: 'fighter_a' }),
    );
  });

  it('publishes a generic market_update for other known event types', async () => {
    await processEvent(makeEvent('market_locked', { market_id: 'm1' }));

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'market_update', marketId: 'm1', eventType: 'market_locked' }),
    );
  });

  it('does not throw when the WebSocket feed is not initialised', async () => {
    (tryGetActivityFeed as jest.Mock).mockReturnValue(null);
    await expect(processEvent(makeEvent('bet_placed', { market_id: 'm1' }))).resolves.not.toThrow();
    expect(publishMock).not.toHaveBeenCalled();
  });
});
