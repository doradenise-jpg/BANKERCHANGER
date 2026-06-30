import type { Response } from 'express';
import { pool } from '../config/db';
import { logger } from '../utils/logger';

const FETCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvRow(values: unknown[]): string {
  return values.map((v) => {
    const s = v == null ? '' : String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',') + '\n';
}

function startCsvStream(res: Response, filename: string): void {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function logExportAudit(
  adminId: string,
  exportType: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, action, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [adminId, `export:${exportType}`, JSON.stringify(params)],
    );
  } catch {
    logger.warn({ msg: 'audit log insert skipped (table may not exist)', exportType });
  }
}

// ---------------------------------------------------------------------------
// Core: stream SQL via server-side cursor in batches → res
// ---------------------------------------------------------------------------

async function pipeQueryToCsv(
  res: Response,
  sql: string,
  values: unknown[],
  header: string[],
  rowMapper: (row: Record<string, unknown>) => string,
): Promise<void> {
  const client = await pool.connect();
  try {
    res.write(csvRow(header));
    await client.query('BEGIN');
    await client.query(`DECLARE export_cursor NO SCROLL CURSOR FOR ${sql}`, values);

    while (true) {
      const { rows } = await client.query(`FETCH ${FETCH_SIZE} FROM export_cursor`);
      if (rows.length === 0) break;
      const chunk = rows.map(rowMapper).join('');
      const ok = res.write(chunk);
      if (!ok) await new Promise<void>((r) => res.once('drain', r));
    }

    await client.query('CLOSE export_cursor');
    await client.query('COMMIT');
    res.end();
  } catch (err) {
    logger.error({ msg: 'CSV stream error', err });
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (!res.writableEnded) res.end();
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Streaming exports
// ---------------------------------------------------------------------------

export async function streamUsersExport(res: Response): Promise<void> {
  startCsvStream(res, 'users.csv');
  await pipeQueryToCsv(
    res,
    `SELECT bettor_address AS wallet_address,
            MIN(placed_at)  AS first_bet_at,
            COUNT(*)        AS total_bets,
            SUM(amount)     AS total_wagered
     FROM bets
     GROUP BY bettor_address
     ORDER BY first_bet_at`,
    [],
    ['wallet_address', 'first_bet_at', 'total_bets', 'total_wagered'],
    (r) => csvRow([r.wallet_address, r.first_bet_at, r.total_bets, r.total_wagered]),
  );
}

export async function streamTradesExport(
  res: Response,
  from?: string,
  to?: string,
): Promise<void> {
  startCsvStream(res, 'trades.csv');
  const conds: string[] = [];
  const vals: unknown[] = [];
  if (from) conds.push(`placed_at >= $${vals.push(from)}`);
  if (to)   conds.push(`placed_at <= $${vals.push(to)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  await pipeQueryToCsv(
    res,
    `SELECT id, market_id, bettor_address, side, amount, placed_at, claimed, payout, tx_hash
     FROM bets ${where} ORDER BY placed_at`,
    vals,
    ['id', 'market_id', 'bettor_address', 'side', 'amount', 'placed_at', 'claimed', 'payout', 'tx_hash'],
    (r) => csvRow([r.id, r.market_id, r.bettor_address, r.side, r.amount, r.placed_at, r.claimed, r.payout, r.tx_hash]),
  );
}

export async function streamTreasuryExport(res: Response): Promise<void> {
  startCsvStream(res, 'treasury.csv');
  await pipeQueryToCsv(
    res,
    `SELECT id, contract_address, event_type, ledger_sequence, ledger_close_time, tx_hash, payload
     FROM blockchain_events
     WHERE event_type ILIKE '%fee%' OR event_type ILIKE '%treasury%'
     ORDER BY ledger_close_time`,
    [],
    ['id', 'contract_address', 'event_type', 'ledger_sequence', 'ledger_close_time', 'tx_hash', 'payload'],
    (r) => csvRow([r.id, r.contract_address, r.event_type, r.ledger_sequence, r.ledger_close_time, r.tx_hash, JSON.stringify(r.payload)]),
  );
}

// ---------------------------------------------------------------------------
// Async (buffered) export — builds full CSV string for email attachment
// ---------------------------------------------------------------------------

export async function buildTradesCsv(from?: string, to?: string): Promise<string> {
  const conds: string[] = [];
  const vals: unknown[] = [];
  if (from) conds.push(`placed_at >= $${vals.push(from)}`);
  if (to)   conds.push(`placed_at <= $${vals.push(to)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT id, market_id, bettor_address, side, amount, placed_at, claimed, payout, tx_hash
     FROM bets ${where} ORDER BY placed_at`,
    vals,
  );

  return (
    csvRow(['id', 'market_id', 'bettor_address', 'side', 'amount', 'placed_at', 'claimed', 'payout', 'tx_hash']) +
    rows.map((r) => csvRow([r.id, r.market_id, r.bettor_address, r.side, r.amount, r.placed_at, r.claimed, r.payout, r.tx_hash])).join('')
  );
}
