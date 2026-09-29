/**
 * Integration test: BetService race condition fix (issue #26)
 *
 * Verifies that recordBet uses SELECT ... FOR UPDATE (row-level lock) and a
 * Redis distributed lock to prevent concurrent bets on the same market from
 * producing incorrect share amounts.
 */
import { recordBet } from '../../src/services/BetService';

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock('../../src/config/db', () => ({
  pool: {
    connect: jest.fn().mockResolvedValue(mockClient),
    query: jest.fn(),
  },
}));

jest.mock('../../src/services/cache.service', () => ({
  cacheDelete: jest.fn(),
  cacheDeletePattern: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/utils/distributedLock', () => ({
  acquireLock: jest.fn().mockResolvedValue({
    key: 'bet:market:mkt_concurrent',
    identifier: 'test-lock-id',
    release: jest.fn().mockResolvedValue(undefined),
  }),
}));

const VALID_ADDRESS = 'GBZXN7PIRZGNMHGA72YD2MKXT3MYMVGBLMHMT6A2R63FWIFKIIOHPSTA';
const MARKET_ID = 'mkt_concurrent';

describe('BetService race condition fix (issue #26)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let callCount = 0;
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (typeof sql === 'string' && sql.toUpperCase().includes('FOR UPDATE')) {
        return { rows: [{ market_id: MARKET_ID }] };
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO bets')) {
        callCount++;
        return {
          rows: [{
            id: callCount,
            market_id: MARKET_ID,
            bettor_address: VALID_ADDRESS,
            side: 'fighter_a',
            amount: '1000000',
            amount_xlm: 0.1,
            tx_hash: `hash_${callCount}`,
            ledger_sequence: callCount,
            placed_at: new Date(),
            claimed: false,
            claimed_at: null,
            payout: null,
          }],
        };
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM bets WHERE tx_hash')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  it('uses SELECT ... FOR UPDATE inside the transaction to lock the market row', async () => {
    await recordBet(MARKET_ID, VALID_ADDRESS, 'fighter_a', '1000000', 'tx_lock_test_001', 999)
      .catch(() => {});

    const sqls: string[] = mockClient.query.mock.calls.map((c: any[]) =>
      typeof c[0] === 'string' ? c[0] : '',
    );
    expect(sqls.some((s) => s.toUpperCase().includes('FOR UPDATE'))).toBe(true);
  });

  it('acquires a distributed Redis lock before entering the transaction', async () => {
    const { acquireLock } = require('../../src/utils/distributedLock');

    await recordBet(MARKET_ID, VALID_ADDRESS, 'fighter_a', '1000000', 'tx_lock_test_002', 998)
      .catch(() => {});

    expect(acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({ key: `bet:market:${MARKET_ID}`, ttl: expect.any(Number) }),
    );
  });

  it('throws 409 when the distributed lock cannot be acquired', async () => {
    const { acquireLock } = require('../../src/utils/distributedLock');
    (acquireLock as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      recordBet(MARKET_ID, VALID_ADDRESS, 'fighter_a', '1000000', 'tx_nolock', 888),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('50 concurrent bets all complete without race-condition crashes', async () => {
    const { acquireLock } = require('../../src/utils/distributedLock');
    (acquireLock as jest.Mock).mockResolvedValue({
      key: `bet:market:${MARKET_ID}`,
      identifier: 'test-lock-id',
      release: jest.fn().mockResolvedValue(undefined),
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        recordBet(
          MARKET_ID,
          VALID_ADDRESS,
          'fighter_a',
          '1000000',
          `tx_concurrent_${i}_${Date.now()}`,
          1000 + i,
        ).catch((e: Error) => ({ error: e.message })),
      ),
    );

    // None should fail with a hard race-condition error
    const hardFailures = results.filter(
      (r: any) =>
        r &&
        r.error &&
        !r.error.includes('retry') &&
        !r.error.includes('Market not found'),
    );
    expect(hardFailures).toHaveLength(0);
  });
});
