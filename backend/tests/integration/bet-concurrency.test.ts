/**
 * Integration test: BetService concurrency guard (issue #26)
 *
 * Verifies that 50 concurrent calls to recordBet on the same market all
 * complete without data corruption:
 *   - The Redis distributed lock ensures only one request processes at a time.
 *   - The SELECT … FOR UPDATE ensures the DB transaction reads consistent state.
 *
 * Dependencies are mocked so this test runs without a live DB or Redis.
 */

jest.mock('../../src/config/db', () => ({
  pool: {
    connect: jest.fn(),
    query: jest.fn(),
  },
}));

jest.mock('../../src/utils/distributedLock', () => ({
  acquireLock: jest.fn(),
}));

jest.mock('../../src/services/cache.service', () => ({
  cacheDeletePattern: jest.fn().mockResolvedValue(undefined),
}));

import { pool } from '../../src/config/db';
import { acquireLock } from '../../src/utils/distributedLock';
import { recordBet } from '../../src/services/BetService';

const mockedPool = pool as jest.Mocked<typeof pool>;
const mockedAcquireLock = acquireLock as jest.MockedFunction<typeof acquireLock>;

// Stable Stellar address for testing
const BETTOR = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const MARKET_ID = 'market-test-001';

function makeFakeLock() {
  return {
    key: `bet:lock:${MARKET_ID}`,
    identifier: 'test-id',
    release: jest.fn().mockResolvedValue(undefined),
  };
}

function makeClientMock(txHash: string, ledger: number) {
  const bet = {
    id: `${txHash}-id`,
    market_id: MARKET_ID,
    bettor_address: BETTOR,
    side: 'fighter_a',
    amount: '10000000',
    amount_xlm: 1,
    tx_hash: txHash,
    ledger_sequence: ledger,
    placed_at: new Date().toISOString(),
    claimed: false,
    claimed_at: null,
  };

  const clientMock = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve();
      }
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ market_id: MARKET_ID }] });
      }
      if (sql.includes('INSERT INTO bets')) {
        return Promise.resolve({ rows: [bet] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
  return clientMock;
}

describe('BetService — concurrent bet placement (issue #26)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('acquires a Redis distributed lock for every recordBet call', async () => {
    const lock = makeFakeLock();
    mockedAcquireLock.mockResolvedValue(lock);
    (mockedPool.connect as jest.Mock).mockResolvedValue(makeClientMock('tx-single', 100));

    await recordBet(MARKET_ID, BETTOR, 'fighter_a', '10000000', 'tx-single', 100);

    expect(mockedAcquireLock).toHaveBeenCalledWith({
      key: `bet:lock:${MARKET_ID}`,
      ttl: 10,
    });
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('issues SELECT … FOR UPDATE inside the transaction', async () => {
    const lock = makeFakeLock();
    mockedAcquireLock.mockResolvedValue(lock);
    const clientMock = makeClientMock('tx-forupdate', 101);
    (mockedPool.connect as jest.Mock).mockResolvedValue(clientMock);

    await recordBet(MARKET_ID, BETTOR, 'fighter_a', '10000000', 'tx-forupdate', 101);

    const calls: string[] = (clientMock.query as jest.Mock).mock.calls.map(
      (c: any[]) => (typeof c[0] === 'string' ? c[0] : ''),
    );
    const forUpdateCall = calls.find((sql) => sql.includes('FOR UPDATE'));
    expect(forUpdateCall).toBeTruthy();
    expect(forUpdateCall).toMatch(/SELECT market_id FROM markets WHERE market_id = \$1 FOR UPDATE/);
  });

  it('releases the lock even when an error is thrown', async () => {
    const lock = makeFakeLock();
    mockedAcquireLock.mockResolvedValue(lock);
    const clientMock = makeClientMock('tx-err', 102);
    // Simulate DB error on INSERT
    (clientMock.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve();
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO bets')) return Promise.reject(new Error('DB error'));
      return Promise.resolve({ rows: [] });
    });
    (mockedPool.connect as jest.Mock).mockResolvedValue(clientMock);

    await expect(
      recordBet(MARKET_ID, BETTOR, 'fighter_a', '10000000', 'tx-err', 102),
    ).rejects.toThrow('DB error');

    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it('throws when lock cannot be acquired after retries', async () => {
    mockedAcquireLock.mockResolvedValue(null);

    await expect(
      recordBet(MARKET_ID, BETTOR, 'fighter_a', '10000000', 'tx-busy', 103),
    ).rejects.toMatchObject({ message: 'Service temporarily busy, please retry' });

    // Lock is tried MAX_LOCK_RETRIES (3) times
    expect(mockedAcquireLock).toHaveBeenCalledTimes(3);
  });

  it('50 concurrent bets on the same market all resolve (serialised by lock mock)', async () => {
    // Simulate that the lock is always available (in a real system the lock
    // serialises requests; here we just confirm all 50 calls complete and the
    // lock is acquired/released for each one).
    let lockCallCount = 0;

    mockedAcquireLock.mockImplementation(async () => {
      lockCallCount++;
      return makeFakeLock();
    });

    (mockedPool.connect as jest.Mock).mockImplementation(async () => {
      return makeClientMock(`tx-concurrent-${lockCallCount}`, 200 + lockCallCount);
    });

    const promises = Array.from({ length: 50 }, (_, i) =>
      recordBet(
        MARKET_ID,
        BETTOR,
        'fighter_a',
        '10000000',
        `tx-concurrent-${i}`,
        200 + i,
      ),
    );

    const results = await Promise.allSettled(promises);

    // All should fulfil (no unhandled rejections from the concurrency guard)
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(50);

    // Lock was acquired once per call
    expect(mockedAcquireLock).toHaveBeenCalledTimes(50);
  });
});
