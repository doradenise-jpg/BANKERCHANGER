/**
 * Unit tests for processEvent routing in StellarIndexer.
 *
 * These tests do NOT require a running database. They inject mock handlers
 * directly into the exported EVENT_HANDLERS dispatch table, which is the
 * seam that processEvent uses internally — avoiding the closed-over binding
 * problem that makes jest.spyOn ineffective here.
 */

// ── Mock DB / cache / Stellar before any module loads ────────────────────────
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

// ── Import after mocks ────────────────────────────────────────────────────────
import { processEvent, EVENT_HANDLERS } from '../../src/indexer/StellarIndexer';
import type { RawStellarEvent } from '../../src/indexer/StellarIndexer';

// ── Helper ────────────────────────────────────────────────────────────────────

function makeEvent(type: string): RawStellarEvent {
  return {
    contract_address: 'CTEST',
    event_type: type,
    topics: [],
    data: '{}',
    ledger_sequence: 1000,
    ledger_close_time: new Date().toISOString(),
    tx_hash: `tx-${type}-${Math.random()}`,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('processEvent routing', () => {
  // Save originals so we can restore between tests
  const originalHandlers = { ...EVENT_HANDLERS };

  // Mock fns — one per known event type
  const mocks: Record<string, jest.Mock> = {};

  beforeEach(() => {
    for (const key of Object.keys(EVENT_HANDLERS)) {
      mocks[key] = jest.fn().mockResolvedValue(undefined);
      EVENT_HANDLERS[key] = mocks[key];
    }
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore original handlers
    for (const key of Object.keys(originalHandlers)) {
      EVENT_HANDLERS[key] = originalHandlers[key];
    }
    jest.restoreAllMocks();
  });

  const knownTypes: Array<[string, string]> = [
    ['market_created',   'market_created'],
    ['bet_placed',       'bet_placed'],
    ['market_locked',    'market_locked'],
    ['market_resolved',  'market_resolved'],
    ['market_cancelled', 'market_cancelled'],
    ['winnings_claimed', 'winnings_claimed'],
    ['refund_claimed',   'refund_claimed'],
  ];

  test.each(knownTypes)(
    'routes %s to its handler and no other handler',
    async (eventType) => {
      const e = makeEvent(eventType);
      await processEvent(e);

      // The matching handler was called with the full event object
      expect(mocks[eventType]).toHaveBeenCalledWith(e);

      // No other handler was invoked
      for (const [otherType] of knownTypes) {
        if (otherType !== eventType) {
          expect(mocks[otherType]).not.toHaveBeenCalled();
        }
      }
    },
  );

  it('emits console.warn for an unknown event type and calls no handler', async () => {
    const e = makeEvent('market_upgraded');
    await processEvent(e);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown event type "market_upgraded"'),
    );
    for (const mock of Object.values(mocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });
});
