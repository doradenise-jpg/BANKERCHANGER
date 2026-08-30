import { pool } from '../config/db';
import { redis } from '../config/redis';

/**
 * Ledger range tracking for the Soroban RPC event poller.
 *
 * The indexer no longer relies solely on a single "last processed ledger"
 * cursor. It persists the exact set of contiguous `[start, end]` ledger ranges
 * that have been fully processed, in both PostgreSQL and Redis. This lets us:
 *
 *   - Detect sequences that were skipped after RPC downtime (gaps between
 *     processed ranges and the network head).
 *   - Backfill only the missing sequences, idempotently.
 *   - Coordinate concurrent pollers safely via an advisory lock and
 *     SERIALIZABLE transactions (transaction isolation).
 */

export interface LedgerRange {
  start: number;
  end: number;
}

const REDIS_RANGES_KEY = 'indexer:processed_ranges';
const REDIS_LAST_KEY = 'indexer:last_processed_ledger';
const RANGES_CACHE_TTL_SECONDS = 30;

// Advisory lock id ("IDXR") serialises writers updating ledger ranges so that
// only one poller records a given range at a time.
const ADVISORY_LOCK_ID = 0x49445852;

/**
 * Merge a set of (possibly overlapping/adjacent) ranges into a compact,
 * sorted, non-overlapping list of contiguous ranges.
 */
export function coalesceRanges(ranges: LedgerRange[]): LedgerRange[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LedgerRange[] = [{ start: sorted[0].start, end: sorted[0].end }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    if (current.start <= last.end + 1) {
      if (current.end > last.end) last.end = current.end;
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }

  return merged;
}

/**
 * Return every range in the half-open interval `[from, latest]` that has NOT
 * yet been processed. Contiguous missing sequences are grouped into ranges so
 * callers can backfill them in batches.
 */
export function findMissingRanges(
  from: number,
  latest: number,
  ranges: LedgerRange[],
): LedgerRange[] {
  if (latest < from) return [];

  const clipped = ranges
    .filter((r) => r.end >= from && r.start <= latest)
    .map((r) => ({
      start: Math.max(r.start, from),
      end: Math.min(r.end, latest),
    }));
  const covered = coalesceRanges(clipped);

  const missing: LedgerRange[] = [];
  let cursor = from;
  for (const r of covered) {
    if (r.start > cursor) {
      missing.push({ start: cursor, end: r.start - 1 });
    }
    cursor = Math.max(cursor, r.end + 1);
    if (cursor > latest) break;
  }
  if (cursor <= latest) {
    missing.push({ start: cursor, end: latest });
  }

  return missing;
}

/** Load the currently tracked ledger ranges, preferring the Redis cache. */
export async function getProcessedRanges(): Promise<LedgerRange[]> {
  const cached = await redis.get(REDIS_RANGES_KEY).catch(() => null);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as LedgerRange[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through to the database on parse errors
    }
  }

  const { rows } = await pool.query(
    'SELECT start_ledger, end_ledger FROM indexer_ledger_ranges ORDER BY start_ledger',
  );
  const ranges = rows.map((r) => ({
    start: Number(r.start_ledger),
    end: Number(r.end_ledger),
  }));

  await redis
    .set(REDIS_RANGES_KEY, JSON.stringify(ranges), 'EX', RANGES_CACHE_TTL_SECONDS)
    .catch(() => undefined);

  return ranges;
}

/** Return the highest consecutively processed ledger (from Redis when cached). */
export async function getLastProcessedLedger(): Promise<number> {
  const cached = await redis.get(REDIS_LAST_KEY).catch(() => null);
  if (cached !== null && cached !== undefined) {
    const n = Number(cached);
    if (Number.isFinite(n)) return n;
  }

  const { rows } = await pool.query(
    'SELECT last_processed_ledger FROM indexer_checkpoints ORDER BY id DESC LIMIT 1',
  );
  const last = rows[0]
    ? Number(rows[0].last_processed_ledger)
    : Number(process.env.GENESIS_LEDGER ?? 0);

  await redis.set(REDIS_LAST_KEY, String(last)).catch(() => undefined);

  return last;
}

/**
 * Persist `[start, end]` as fully processed, under transaction isolation.
 *
 * The write runs inside a SERIALIZABLE transaction guarded by an advisory
 * lock, then coalesces the new range with any existing ranges, rewrites the
 * compact range set, and advances the single-cursor checkpoint to the highest
 * ledger covered. The Redis cache is refreshed only after the transaction
 * commits.
 */
export async function recordProcessedRange(start: number, end: number): Promise<void> {
  if (end < start) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_ID]);

    const { rows } = await client.query(
      'SELECT start_ledger, end_ledger FROM indexer_ledger_ranges ORDER BY start_ledger',
    );
    const existing = rows.map((r) => ({
      start: Number(r.start_ledger),
      end: Number(r.end_ledger),
    }));

    const merged = coalesceRanges([...existing, { start, end }]);

    await client.query('DELETE FROM indexer_ledger_ranges');
    for (const range of merged) {
      await client.query(
        'INSERT INTO indexer_ledger_ranges (start_ledger, end_ledger) VALUES ($1, $2)',
        [range.start, range.end],
      );
    }

    const maxEnd = merged.length > 0 ? merged[merged.length - 1].end : end;
    await client.query(
      `INSERT INTO indexer_checkpoints (id, last_processed_ledger)
       VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE
         SET last_processed_ledger =
               GREATEST(indexer_checkpoints.last_processed_ledger, EXCLUDED.last_processed_ledger),
             updated_at = NOW()`,
      [maxEnd],
    );

    await client.query('COMMIT');

    await redis.set(REDIS_RANGES_KEY, JSON.stringify(merged)).catch(() => undefined);
    await redis.set(REDIS_LAST_KEY, String(maxEnd)).catch(() => undefined);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
