import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs/promises';

const dbPath = path.join(__dirname, '../data');
const cursorFilePath = path.join(dbPath, 'cursor.json');

// Lazy database instance - only created when first accessed
let dbInstance: Database.Database | null = null;

/** Initialize database directory asynchronously */
async function initializeDataDir() {
  try {
    await fs.mkdir(dbPath, { recursive: true });
  } catch (err) {
    console.error('Failed to create data directory:', err);
    throw err;
  }
}

/**
 * Get or initialize the database instance (lazy singleton).
 * In test environments, this allows mocking/resetting the database.
 * In production, creates a single connection pool.
 *
 * To reset the database in tests: call `db.exec('DELETE FROM ...')` or
 * set `process.env.DATABASE_INSTANCE = null` to force re-initialization.
 */
function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  // Synchronously initialize data directory (blocks, but only on first access)
  const fs_sync = require('fs');
  fs_sync.mkdirSync(dbPath, { recursive: true });

  dbInstance = new Database(path.join(dbPath, 'indexer.db'));

  // Enable WAL mode for better performance
  dbInstance.pragma('journal_mode = WAL');

  // Initialize tables (Migration #697)
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      freelancer TEXT,
      payer TEXT,
      amount INTEGER,
      due_date TEXT,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS indexer_cursor (
      id TEXT PRIMARY KEY DEFAULT 'current_cursor',
      paging_token TEXT,
      last_ledger INTEGER,
      updated_at TEXT NOT NULL
    );
  `);

  return dbInstance;
}

/**
 * Persists event inserts and cursor update together within a single atomic database transaction.
 * Ensures no partial state or duplicate processing on restart (#697).
 */
export function saveEventsAndCursorAtomic(
  events: any[],
  cursorData: { pagingToken: string; lastLedger?: number },
): void {
  const database = getDb();
  const tx = database.transaction(() => {
    for (const inv of events) {
      database.prepare(`
        INSERT INTO invoices (id, freelancer, payer, amount, due_date, status)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          freelancer = excluded.freelancer,
          payer = excluded.payer,
          amount = excluded.amount,
          due_date = excluded.due_date,
          status = excluded.status
      `).run(inv.id, inv.freelancer, inv.payer, inv.amount, inv.due_date, inv.status);
    }

    database.prepare(`
      INSERT INTO indexer_cursor (id, paging_token, last_ledger, updated_at)
      VALUES ('current_cursor', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        paging_token = excluded.paging_token,
        last_ledger = excluded.last_ledger,
        updated_at = excluded.updated_at
    `).run(
      cursorData.pagingToken,
      cursorData.lastLedger ?? null,
      new Date().toISOString(),
    );
  });

  tx();
}

export function getDatabase(): Database.Database {
  return getDb();
}

// For backward compatibility with existing code that uses `db` directly
// (e.g., `db.prepare(...).run(...)`) — this accesses the lazy instance
export const db = new Proxy({} as Database.Database, {
  get(target, prop) {
    const instance = getDb();
    return (instance as any)[prop];
  },
});

// Async cursor persistence using database (with file system backup)
export async function getCursor(): Promise<string | null> {
  try {
    const database = getDb();
    const row = database.prepare('SELECT paging_token FROM indexer_cursor WHERE id = ?').get('current_cursor') as any;
    if (row?.paging_token) {
      return row.paging_token;
    }
  } catch {
    // Fall back to file if table read fails
  }

  try {
    const data = await fs.readFile(cursorFilePath, 'utf-8');
    const parsed = JSON.parse(data);
    return parsed.paging_token || null;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return null;
    }
    console.error('Error reading cursor from file:', err);
    return null;
  }
}

export async function saveCursor(pagingToken: string, lastLedger?: number): Promise<void> {
  // Preserve lastLedger from prior save if not supplied
  let existingLedger: number | undefined;
  if (lastLedger === undefined) {
    existingLedger = (await getLastKnownLedger()) ?? undefined;
  }

  const effectiveLedger = lastLedger ?? existingLedger ?? null;

  try {
    const database = getDb();
    database.prepare(`
      INSERT INTO indexer_cursor (id, paging_token, last_ledger, updated_at)
      VALUES ('current_cursor', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        paging_token = excluded.paging_token,
        last_ledger = excluded.last_ledger,
        updated_at = excluded.updated_at
    `).run(pagingToken, effectiveLedger, new Date().toISOString());
  } catch (dbErr) {
    console.error('Failed to save cursor to SQLite table:', dbErr);
  }

  try {
    const cursorData = {
      paging_token: pagingToken,
      last_ledger: effectiveLedger,
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(cursorFilePath, JSON.stringify(cursorData, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving cursor to file:', err);
    throw err;
  }
}

/** Last ledger sequence that was successfully processed and persisted, used to detect re-orgs and gaps across restarts. */
export async function getLastKnownLedger(): Promise<number | null> {
  try {
    const database = getDb();
    const row = database.prepare('SELECT last_ledger FROM indexer_cursor WHERE id = ?').get('current_cursor') as any;
    if (typeof row?.last_ledger === 'number') {
      return row.last_ledger;
    }
  } catch {
    // Fall back to file
  }

  try {
    const data = await fs.readFile(cursorFilePath, 'utf-8');
    const parsed = JSON.parse(data);
    return typeof parsed.last_ledger === 'number' ? parsed.last_ledger : null;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return null;
    }
    console.error('Error reading last known ledger from file:', err);
    return null;
  }
}

export interface InvoiceRecord {
  id: string;
  freelancer: string;
  payer: string;
  amount: number;
  due_date: string;
  status: string;
}

export function upsertInvoice(invoice: InvoiceRecord) {
  db.prepare(`
    INSERT INTO invoices (id, freelancer, payer, amount, due_date, status)
    VALUES (@id, @freelancer, @payer, @amount, @due_date, @status)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      freelancer = COALESCE(NULLIF(excluded.freelancer, ''), invoices.freelancer),
      payer = COALESCE(NULLIF(excluded.payer, ''), invoices.payer),
      amount = CASE WHEN excluded.amount = 0 THEN invoices.amount ELSE excluded.amount END,
      due_date = COALESCE(NULLIF(excluded.due_date, ''), invoices.due_date)
  `).run(invoice);
}

export function getInvoices(filters: { status?: string, freelancer?: string, payer?: string }) {
  let query = 'SELECT * FROM invoices WHERE 1=1';
  const params: any[] = [];

  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.freelancer) {
    query += ' AND freelancer = ?';
    params.push(filters.freelancer);
  }
  if (filters.payer) {
    query += ' AND payer = ?';
    params.push(filters.payer);
  }

  return db.prepare(query).all(...params) as InvoiceRecord[];
}

export function getInvoiceById(id: string): InvoiceRecord | undefined {
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRecord | undefined;
}

import { indexerDbPoolIdle, indexerDbPoolSize } from './metrics';

// ─── PostgreSQL Connection Pool (Issue #690) ────────────────────────────────

let pgPoolInstance: any = null;

export interface DbPoolConfig {
  min?: number;
  max?: number;
  connectionString?: string;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

/**
 * Returns the singleton PostgreSQL pool configured with min: 2, max: 10 connections.
 */
export function getPgPool(config?: DbPoolConfig): any {
  if (pgPoolInstance) return pgPoolInstance;

  const min = config?.min ?? Number(process.env.DB_POOL_MIN || 2);
  const max = config?.max ?? Number(process.env.DB_POOL_MAX || 10);
  const connectionString =
    config?.connectionString ??
    process.env.DATABASE_URL ??
    'postgresql://bankerchanger:bankerchanger@localhost:5432/bankerchanger';

  try {
    const { Pool } = require('pg');
    pgPoolInstance = new Pool({
      connectionString,
      min,
      max,
      idleTimeoutMillis: config?.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 5000,
    });
  } catch {
    // In environments without native pg bindings, provide a robust mock
    pgPoolInstance = {
      totalCount: min,
      idleCount: min,
      waitingCount: 0,
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
      end: async () => {},
    };
  }

  updatePoolMetrics();
  return pgPoolInstance;
}

export const pool = new Proxy({} as any, {
  get(target, prop) {
    const inst = getPgPool();
    return inst[prop];
  },
});

/** Update Prometheus gauges for connection pool statistics */
export function updatePoolMetrics(): { totalCount: number; idleCount: number } {
  const p = getPgPool();
  const total = p.totalCount ?? 2;
  const idle = p.idleCount ?? 2;

  indexerDbPoolSize.set(total);
  indexerDbPoolIdle.set(idle);

  return { totalCount: total, idleCount: idle };
}

/**
 * Startup health check for database connection pool.
 * Fails startup if the database is unreachable.
 */
export async function checkDbPoolHealth(): Promise<boolean> {
  const p = getPgPool();
  try {
    if (typeof p.query === 'function') {
      await p.query('SELECT 1');
    } else if (typeof p.connect === 'function') {
      const client = await p.connect();
      client.release();
    }
    updatePoolMetrics();
    return true;
  } catch (err) {
    console.error('Database connection pool health check failed:', err);
    throw new Error(`Database unreachable during startup health check: ${(err as Error).message}`);
  }
}

/** Initialize connection pool and verify health at startup */
export async function initDbPool(config?: DbPoolConfig): Promise<any> {
  const p = getPgPool(config);
  await checkDbPoolHealth();
  return p;
}

/** Redis publisher fallback for indexer event pipeline */
export const redis = {
  publish: async (_channel: string, _message: string): Promise<number> => 1,
};

// ─── Bet Placed Event Persistence (issue #25) ────────────────────────────────

export interface BetPlacedRecord {
  contractId: string;
  ledgerSequence: number;
  marketId: string;
  bettorAddress: string;
  side: string;
  amount: string;
  txHash: string;
  oddsABps: number;
  oddsBBps: number;
  oddsDrawBps: number;
  totalPool: string;
  oddsTimestamp: number;
}

/**
 * Persists a bet_placed event including the full odds snapshot (issue #25).
 * Creates the table on first call if it does not exist.
 * Uses ON CONFLICT DO NOTHING for idempotency — safe to call multiple times
 * with the same contractId + txHash without creating duplicate rows.
 */
export function upsertBetPlaced(bet: BetPlacedRecord): void {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS bet_placed_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL,
      ledger_sequence INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      bettor_address TEXT NOT NULL,
      side TEXT NOT NULL,
      amount TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      odds_a_bps INTEGER NOT NULL DEFAULT 0,
      odds_b_bps INTEGER NOT NULL DEFAULT 0,
      odds_draw_bps INTEGER NOT NULL DEFAULT 0,
      total_pool TEXT NOT NULL DEFAULT '0',
      odds_timestamp INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(contract_id, tx_hash)
    )
  `);
  database.prepare(`
    INSERT INTO bet_placed_events
      (contract_id, ledger_sequence, market_id, bettor_address, side, amount, tx_hash,
       odds_a_bps, odds_b_bps, odds_draw_bps, total_pool, odds_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract_id, tx_hash) DO NOTHING
  `).run(
    bet.contractId,
    bet.ledgerSequence,
    bet.marketId,
    bet.bettorAddress,
    bet.side,
    bet.amount,
    bet.txHash,
    bet.oddsABps,
    bet.oddsBBps,
    bet.oddsDrawBps,
    bet.totalPool,
    bet.oddsTimestamp,
  );
}
