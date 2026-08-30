import type { Response } from 'express';
import { pool } from '../config/db';
import { logger } from '../utils/logger';
import { getEnv } from '../config/env';

const FETCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvRow(values: unknown[]): string {
  return values.map((v) => {
    const s = v == null ? '' : String(v);
    return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
  maxRows: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    res.write(csvRow(header));
    await client.query('BEGIN');
    await client.query(`DECLARE export_cursor NO SCROLL CURSOR FOR ${sql}`, values);

    let rowCount = 0;
    while (true) {
      const { rows } = await client.query(`FETCH ${FETCH_SIZE} FROM export_cursor`);
      if (rows.length === 0) break;
      const remaining = maxRows - rowCount;
      if (remaining <= 0) break;
      rows.splice(remaining);
      const chunk = rows.map(rowMapper).join('');
      const ok = res.write(chunk);
      if (!ok) await new Promise<void>((r) => res.once('drain', r));
      rowCount += rows.length;
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
  const { MAX_EXPORT_ROWS } = getEnv();

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS count FROM (SELECT 1 FROM bets GROUP BY bettor_address) sub`,
  );
  if (Number(countRows[0]?.count ?? 0) > MAX_EXPORT_ROWS) {
    res.status(413).json({ error: 'Export too large' });
    return;
  }

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
    MAX_EXPORT_ROWS,
  );
}

export async function streamTradesExport(
  res: Response,
  from?: string,
  to?: string,
): Promise<void> {
  const { MAX_EXPORT_ROWS } = getEnv();

  const conds: string[] = [];
  const vals: unknown[] = [];
  if (from) conds.push(`placed_at >= $${vals.push(from)}`);
  if (to)   conds.push(`placed_at <= $${vals.push(to)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS count FROM bets ${where}`,
    vals,
  );
  if (Number(countRows[0]?.count ?? 0) > MAX_EXPORT_ROWS) {
    res.status(413).json({ error: 'Export too large' });
    return;
  }

  startCsvStream(res, 'trades.csv');
  await pipeQueryToCsv(
    res,
    `SELECT id, market_id, bettor_address, side, amount, placed_at, claimed, payout, tx_hash
     FROM bets ${where} ORDER BY placed_at`,
    vals,
    ['id', 'market_id', 'bettor_address', 'side', 'amount', 'placed_at', 'claimed', 'payout', 'tx_hash'],
    (r) => csvRow([r.id, r.market_id, r.bettor_address, r.side, r.amount, r.placed_at, r.claimed, r.payout, r.tx_hash]),
    MAX_EXPORT_ROWS,
  );
}

export async function streamTreasuryExport(res: Response): Promise<void> {
  const { MAX_EXPORT_ROWS } = getEnv();
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
    MAX_EXPORT_ROWS,
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

// ---------------------------------------------------------------------------
// User History Tax and Audit Report Export
// ---------------------------------------------------------------------------

export interface UserHistoryExportFilter {
  address: string;
  format: 'csv' | 'json';
  startDate?: string;
  endDate?: string;
}

export async function streamUserHistoryReport(
  res: Response,
  filter: UserHistoryExportFilter,
): Promise<void> {
  const { address, format, startDate, endDate } = filter;
  const filename = `audit-history-${address}-${Date.now()}.${format}`;

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write('Timestamp (UTC),Transaction Hash,Market ID,Market Title,Action Type,Outcome Picked,Amount (XLM),Payout (XLM),Net PnL (XLM)\n');
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.write('[\n');
  }

  let cursorId = 0;
  const batchSize = FETCH_SIZE;
  let isFirstJson = true;

  try {
    while (true) {
      const conds: string[] = ['b.bettor_address = $1', 'b.id > $2'];
      const vals: unknown[] = [address, cursorId];

      if (startDate) {
        conds.push(`b.placed_at >= $${vals.push(startDate)}`);
      }
      if (endDate) {
        conds.push(`b.placed_at <= $${vals.push(endDate)}`);
      }

      const query = `
        SELECT 
          b.id,
          b.market_id,
          b.bettor_address,
          b.side,
          b.amount,
          b.amount_xlm,
          b.placed_at,
          b.claimed,
          b.claimed_at,
          b.payout,
          b.tx_hash,
          m.fighter_a,
          m.fighter_b,
          m.match_id,
          m.status AS market_status,
          m.outcome AS market_outcome
        FROM bets b
        LEFT JOIN markets m ON b.market_id = m.market_id
        WHERE ${conds.join(' AND ')}
        ORDER BY b.id ASC
        LIMIT ${batchSize}
      `;

      const { rows } = await pool.query(query, vals);
      if (rows.length === 0) break;

      for (const r of rows) {
        cursorId = Number(r.id);

        const amountXlm = r.amount_xlm != null ? Number(r.amount_xlm) : Number(r.amount) / 10_000_000;
        const marketTitle = r.fighter_a && r.fighter_b ? `${r.fighter_a} vs ${r.fighter_b}` : (r.match_id || r.market_id || 'Unknown Market');
        const outcomePicked = r.side === 'fighter_a' ? (r.fighter_a || 'Fighter A') : r.side === 'fighter_b' ? (r.fighter_b || 'Fighter B') : (r.side === 'draw' ? 'Draw' : r.side);

        // Action 1: BET placement record
        const betTimestamp = new Date(r.placed_at).toISOString();
        const betItem = {
          timestamp: betTimestamp,
          transactionHash: r.tx_hash,
          marketId: r.market_id,
          marketTitle,
          actionType: 'BET',
          outcomePicked,
          amountXlm,
          payoutXlm: 0,
          netPnlXlm: -amountXlm,
          'Timestamp (UTC)': betTimestamp,
          'Transaction Hash': r.tx_hash,
          'Market ID': r.market_id,
          'Market Title': marketTitle,
          'Action Type': 'BET',
          'Outcome Picked': outcomePicked,
          'Amount (XLM)': amountXlm,
          'Payout (XLM)': 0,
          'Net PnL (XLM)': -amountXlm,
        };

        const items = [betItem];

        // Action 2: CLAIM / REFUND record if claimed
        if (r.claimed) {
          const rawPayout = Number(r.payout) || 0;
          const payoutXlm = rawPayout > 100_000 ? rawPayout / 10_000_000 : rawPayout;
          const actionType = r.market_status === 'cancelled' ? 'REFUND' : 'CLAIM';
          const netPnlXlm = payoutXlm - amountXlm;
          const claimTimestamp = new Date(r.claimed_at || r.placed_at).toISOString();

          const claimItem = {
            timestamp: claimTimestamp,
            transactionHash: r.tx_hash,
            marketId: r.market_id,
            marketTitle,
            actionType,
            outcomePicked,
            amountXlm: 0,
            payoutXlm,
            netPnlXlm,
            'Timestamp (UTC)': claimTimestamp,
            'Transaction Hash': r.tx_hash,
            'Market ID': r.market_id,
            'Market Title': marketTitle,
            'Action Type': actionType,
            'Outcome Picked': outcomePicked,
            'Amount (XLM)': 0,
            'Payout (XLM)': payoutXlm,
            'Net PnL (XLM)': netPnlXlm,
          };
          items.push(claimItem);
        }

        for (const item of items) {
          if (format === 'csv') {
            const line = [
              item['Timestamp (UTC)'],
              item['Transaction Hash'],
              item['Market ID'],
              item['Market Title'],
              item['Action Type'],
              item['Outcome Picked'],
              item['Amount (XLM)'],
              item['Payout (XLM)'],
              item['Net PnL (XLM)'],
            ];
            const ok = res.write(csvRow(line));
            if (!ok) await new Promise<void>((resolve) => res.once('drain', resolve));
          } else {
            const chunk = (isFirstJson ? '  ' : ',\n  ') + JSON.stringify(item);
            isFirstJson = false;
            const ok = res.write(chunk);
            if (!ok) await new Promise<void>((resolve) => res.once('drain', resolve));
          }
        }
      }

      if (rows.length < batchSize) break;
    }

    if (format === 'json') {
      res.write('\n]\n');
    }
    res.end();
  } catch (err) {
    logger.error({ msg: 'User history export error', err });
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Internal server error' });
    } else {
      res.end();
    }
  }
}
