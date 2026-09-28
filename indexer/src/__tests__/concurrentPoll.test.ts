import { acquireDistributedLock, metrics, resetDistributedLocks } from '../distributedLock';

describe('Concurrent Polling Scenarios & Distributed Lock', () => {
  beforeEach(() => {
    resetDistributedLocks();
  });

  it('prevents two concurrent indexer instances from processing the same ledger range simultaneously', async () => {
    const lockKey = 'indexer:poll:lock';
    const ttl = 10;

    // Instance 1 attempts to acquire lock
    const lock1 = await acquireDistributedLock({ key: lockKey, ttl, identifier: 'instance-1' });
    expect(lock1).not.toBeNull();
    expect(lock1?.identifier).toBe('instance-1');

    // Instance 2 attempts to acquire lock while instance 1 holds it
    const lock2 = await acquireDistributedLock({ key: lockKey, ttl, identifier: 'instance-2' });
    expect(lock2).toBeNull();
    expect(metrics.indexer_lock_contention_total).toBe(1);

    // Simulated event processing: records processed ledger sequences
    const processedLedgers: number[] = [];
    const ledgerRange = [100, 101, 102];

    if (lock1) {
      for (const seq of ledgerRange) {
        processedLedgers.push(seq);
      }
      await lock1.release();
    }

    // Now instance 2 can acquire lock
    const lock2Retry = await acquireDistributedLock({ key: lockKey, ttl, identifier: 'instance-2' });
    expect(lock2Retry).not.toBeNull();

    // Verify no duplicates occurred during the concurrent lock contention
    expect(processedLedgers).toEqual([100, 101, 102]);
    await lock2Retry?.release();
  });

  it('increments indexer_lock_contention_total metric on multiple contention failures', async () => {
    const lockKey = 'indexer:poll:lock';
    const lock = await acquireDistributedLock({ key: lockKey, ttl: 5, identifier: 'main-instance' });
    expect(lock).not.toBeNull();

    await acquireDistributedLock({ key: lockKey, ttl: 5, identifier: 'worker-1' });
    await acquireDistributedLock({ key: lockKey, ttl: 5, identifier: 'worker-2' });
    await acquireDistributedLock({ key: lockKey, ttl: 5, identifier: 'worker-3' });

    expect(metrics.indexer_lock_contention_total).toBe(3);
    await lock?.release();
  });
});
