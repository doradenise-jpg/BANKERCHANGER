import {
  coalesceRanges,
  findMissingRanges,
  getProcessedRanges,
  getLastProcessedLedger,
  recordProcessedRange,
  type LedgerRange,
} from '../../src/indexer/ledgerTracker';

jest.mock('../../src/config/redis', () => ({
  redis: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

jest.mock('../../src/config/db', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

import { redis } from '../../src/config/redis';
import { pool } from '../../src/config/db';

describe('coalesceRanges', () => {
  it('merges adjacent and overlapping ranges', () => {
    const input: LedgerRange[] = [
      { start: 1, end: 5 },
      { start: 6, end: 10 },
      { start: 12, end: 15 },
      { start: 14, end: 20 },
    ];
    expect(coalesceRanges(input)).toEqual([
      { start: 1, end: 10 },
      { start: 12, end: 20 },
    ]);
  });

  it('returns empty for empty input', () => {
    expect(coalesceRanges([])).toEqual([]);
  });

  it('handles a single range', () => {
    expect(coalesceRanges([{ start: 3, end: 7 }])).toEqual([{ start: 3, end: 7 }]);
  });
});

describe('findMissingRanges', () => {
  it('reports every missing sequence between from and latest', () => {
    const processed: LedgerRange[] = [{ start: 100, end: 199 }];
    // from = 100, latest = 210 → 100..199 processed, 200..210 missing
    expect(findMissingRanges(100, 210, processed)).toEqual([{ start: 200, end: 210 }]);
  });

  it('reports the entire range when nothing is processed', () => {
    expect(findMissingRanges(50, 60, [])).toEqual([{ start: 50, end: 60 }]);
  });

  it('detects a hole in the middle of processed ranges (RPC downtime gap)', () => {
    const processed: LedgerRange[] = [
      { start: 1, end: 100 },
      { start: 130, end: 150 },
    ];
    // 1..100 processed, 101..129 missing, 130..150 processed
    expect(findMissingRanges(1, 150, processed)).toEqual([{ start: 101, end: 129 }]);
  });

  it('returns empty when everything is processed', () => {
    const processed: LedgerRange[] = [{ start: 1, end: 200 }];
    expect(findMissingRanges(1, 200, processed)).toEqual([]);
  });

  it('handles destination below from', () => {
    expect(findMissingRanges(100, 90, [])).toEqual([]);
  });
});

describe('getLastProcessedLedger', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the Redis-cached value when present', async () => {
    (redis.get as jest.Mock).mockResolvedValue('42');
    await expect(getLastProcessedLedger()).resolves.toBe(42);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('falls back to Postgres and caches when Redis is empty', async () => {
    (redis.get as jest.Mock).mockResolvedValue(null);
    (pool.query as jest.Mock).mockResolvedValue({ rows: [{ last_processed_ledger: 77 }] });

    await expect(getLastProcessedLedger()).resolves.toBe(77);
    expect(redis.set).toHaveBeenCalledWith('indexer:last_processed_ledger', '77');
  });

  it('defaults to GENESIS_LEDGER when no checkpoint exists', async () => {
    (redis.get as jest.Mock).mockResolvedValue(null);
    (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

    await expect(getLastProcessedLedger()).resolves.toBe(0);
  });
});

describe('getProcessedRanges', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns ranges from the Redis cache when present', async () => {
    (redis.get as jest.Mock).mockResolvedValue(JSON.stringify([{ start: 1, end: 5 }]));
    await expect(getProcessedRanges()).resolves.toEqual([{ start: 1, end: 5 }]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('falls back to Postgres when Redis is empty and caches the result', async () => {
    (redis.get as jest.Mock).mockResolvedValue(null);
    (pool.query as jest.Mock).mockResolvedValue({
      rows: [
        { start_ledger: 1, end_ledger: 10 },
        { start_ledger: 20, end_ledger: 30 },
      ],
    });

    await expect(getProcessedRanges()).resolves.toEqual([
      { start: 1, end: 10 },
      { start: 20, end: 30 },
    ]);
    expect(redis.set).toHaveBeenCalled();
  });
});

describe('recordProcessedRange', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is a no-op for an inverted range', async () => {
    await recordProcessedRange(10, 5);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('writes inside a transaction-isolated, advisory-locked transaction', async () => {
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('SELECT start_ledger, end_ledger FROM indexer_ledger_ranges')) {
          return { rows: [{ start_ledger: 1, end_ledger: 5 }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    (pool.connect as jest.Mock).mockResolvedValue(client);

    await recordProcessedRange(6, 10);

    expect(client.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL SERIALIZABLE');
    // advisory xact lock used for isolation between concurrent pollers
    expect(queries.some((q) => q.startsWith('SELECT pg_advisory_xact_lock'))).toBe(true);
    // coalesced (1..5) + (6..10) → (1..10); checkpoint advanced to 10
    expect(queries.some((q) => q.includes('INSERT INTO indexer_checkpoints'))).toBe(true);
    expect(queries.some((q) => q === 'COMMIT')).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      'indexer:last_processed_ledger',
      '10',
    );
  });

  it('rolls back on failure and propagates the error', async () => {
    const client = {
      query: jest.fn().mockRejectedValueOnce(new Error('boom')),
      release: jest.fn(),
    };
    (pool.connect as jest.Mock).mockResolvedValue(client);

    await expect(recordProcessedRange(1, 10)).rejects.toThrow('boom');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
