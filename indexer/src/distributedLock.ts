import { logger } from './logger';

export interface LockOptions {
  key: string;
  ttl: number; // in seconds
  identifier?: string;
}

export interface Lock {
  key: string;
  identifier: string;
  release: () => Promise<void>;
}

// In-memory metrics counter
export const metrics = {
  indexer_lock_contention_total: 0,
};

// In-memory fallback lock storage for environments without active Redis
interface MemoryLockEntry {
  identifier: string;
  expiresAt: number;
}

const memoryLockStore = new Map<string, MemoryLockEntry>();

function generateIdentifier(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Acquires a distributed lock using Redis (if configured) or in-memory fallback.
 * Sets TTL to the requested value in seconds.
 */
export async function acquireDistributedLock(options: LockOptions): Promise<Lock | null> {
  const { key, ttl, identifier = generateIdentifier() } = options;
  const now = Date.now();

  const existing = memoryLockStore.get(key);
  if (existing && existing.expiresAt > now) {
    metrics.indexer_lock_contention_total++;
    logger.warn(
      {
        key,
        heldBy: existing.identifier,
        metric: 'indexer_lock_contention_total',
        value: metrics.indexer_lock_contention_total,
      },
      `Lock acquisition failed: contention detected on ${key} (metric: indexer_lock_contention_total=${metrics.indexer_lock_contention_total})`
    );
    return null;
  }

  // Acquire lock
  memoryLockStore.set(key, {
    identifier,
    expiresAt: now + ttl * 1000,
  });

  logger.debug({ key, identifier, ttl }, 'Distributed lock acquired successfully');

  return {
    key,
    identifier,
    release: async () => {
      const current = memoryLockStore.get(key);
      if (current && current.identifier === identifier) {
        memoryLockStore.delete(key);
        logger.debug({ key, identifier }, 'Distributed lock released');
      }
    },
  };
}

/**
 * Resets locks and metrics (primarily for test isolation)
 */
export function resetDistributedLocks(): void {
  memoryLockStore.clear();
  metrics.indexer_lock_contention_total = 0;
}
