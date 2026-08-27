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

  // Initialize tables
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      freelancer TEXT,
      payer TEXT,
      amount INTEGER,
      due_date TEXT,
      status TEXT NOT NULL
    );
  `);

  return dbInstance;
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

// Async cursor persistence using file system
export async function getCursor(): Promise<string | null> {
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
  try {
    // Preserve lastLedger from a prior save when the caller doesn't supply one,
    // so cursor and ledger-continuity tracking never drift apart on partial writes.
    let existingLedger: number | undefined;
    if (lastLedger === undefined) {
      existingLedger = (await getLastKnownLedger()) ?? undefined;
    }

    const cursorData = {
      paging_token: pagingToken,
      last_ledger: lastLedger ?? existingLedger ?? null,
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
