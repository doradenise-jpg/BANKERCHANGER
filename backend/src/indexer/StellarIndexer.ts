// ============================================================
// BANKERCHANGER — Stellar Blockchain Indexer
//
// Listens to the Stellar network for contract events emitted
// by MarketFactory, Market, and Treasury contracts.
// Persists all relevant state changes to the PostgreSQL DB.
// ============================================================

import { pool } from '../config/db';
import { rpc, Address, xdr } from '@stellar/stellar-sdk';
import { subscribeToContractEvents, fetchHistoricalEvents } from '../services/StellarService';
import { cacheDeletePattern } from '../services/cache.service';
import { tryGetActivityFeed, getActivityFeedIfInitialized, type ActivityEvent } from '../websocket/realtime';
import {
  findMissingRanges,
  getProcessedRanges,
  getLastProcessedLedger as getTrackerLastProcessed,
  recordProcessedRange,
} from './ledgerTracker';

// Raw event shape returned by Stellar RPC / Horizon
export interface RawStellarEvent {
  contract_address: string;
  event_type: string;
  topics: string[];
  data: string; // JSON-encoded flat event payload
  ledger_sequence: number;
  ledger_close_time: string;
  tx_hash: string;
}

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const FACTORY_CONTRACT = process.env.FACTORY_CONTRACT_ADDRESS || '';
const TREASURY_CONTRACT = process.env.TREASURY_CONTRACT_ADDRESS || '';

const server = new rpc.Server(RPC_URL);

/**
 * Publishes to the WebSocket activity feed, if one has been initialised.
 * Ingestion must not fail just because no server has wired up a feed yet.
 */
function publishActivity(event: ActivityEvent): void {
  try {
    const feed = tryGetActivityFeed() || getActivityFeedIfInitialized();
    feed?.publish(event);
  } catch (err) {
    console.error('[Indexer] Failed to publish activity event:', err instanceof Error ? err.message : err);
  }
}

// ── Health tracking for the fallback ledger-polling loop ────────────────────
export interface IndexerHealth {
  isRunning: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessfulPollAt: string | null;
}

const indexerHealth: IndexerHealth = {
  isRunning: false,
  consecutiveFailures: 0,
  lastError: null,
  lastErrorAt: null,
  lastSuccessfulPollAt: null,
};

export function getIndexerHealth(): IndexerHealth {
  return { ...indexerHealth };
}

// ── Exponential backoff for RPC failures ────────────────────────────────────
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60 * 1000;
const BACKOFF_MULTIPLIER = 2;

export function calculateBackoff(failureCount: number): number {
  const backoff = MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, Math.max(failureCount - 1, 0));
  const capped = Math.min(backoff, MAX_BACKOFF_MS);
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

export function calculatePollBackoff(consecutiveFailures: number): number {
  return calculateBackoff(consecutiveFailures);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const REORG_REWIND_LEDGERS = 5;
const LEDGER_UNAVAILABLE_PATTERN = /ledger.*(not found|out.?of.?range|outside the range|before the oldest|retention window)/i;

export function isLedgerUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return LEDGER_UNAVAILABLE_PATTERN.test(message);
}

function isLedgerRangeError(err: unknown): boolean {
  return isLedgerUnavailableError(err);
}

export async function startIndexer(): Promise<void> {
  const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  let lastProcessed = await getLastProcessedLedger();

  console.log(`[Indexer] Starting from ledger ${lastProcessed}`);

  const checkpoint = await loadCheckpoint();
  if (checkpoint && checkpoint > lastProcessed) {
    console.log(`[Indexer] Backfilling from ledger ${lastProcessed + 1} to ${checkpoint}`);
    await backfillFromLedger(lastProcessed + 1, checkpoint);
    lastProcessed = checkpoint;
  }

  console.log(`[Indexer] Starting real-time subscription from ledger ${lastProcessed}`);
  console.log(`[Indexer] Subscribing to contracts: factory=${FACTORY_CONTRACT}, treasury=${TREASURY_CONTRACT || 'not configured'}`);
  
  const handleRealTimeEvent = async (event: unknown) => {
    try {
      const eventData = event as Record<string, unknown>;
      const rawEvent: RawStellarEvent = {
        contract_address: (eventData.contract_address as string) || FACTORY_CONTRACT,
        event_type: (eventData.type as string) || 'unknown',
        topics: (eventData.topics as string[]) || [],
        data: JSON.stringify(event),
        ledger_sequence: (eventData.ledger as number) || 0,
        ledger_close_time: (eventData.ledger_close_time as string) || new Date().toISOString(),
        tx_hash: (eventData.tx_hash as string) || '',
      };
      await processEvent(rawEvent);
    } catch (err) {
      console.error('[Indexer] Error processing real-time event:', err);
    }
  };

  const unsubscribeFactory = subscribeToContractEvents(FACTORY_CONTRACT, handleRealTimeEvent);
  let unsubscribeTreasury = () => {};
  if (TREASURY_CONTRACT) {
    unsubscribeTreasury = subscribeToContractEvents(TREASURY_CONTRACT, handleRealTimeEvent);
  }

  process.on('SIGTERM', () => {
    console.log('[Indexer] SIGTERM received, shutting down gracefully');
    indexerHealth.isRunning = false;
    unsubscribeFactory();
    unsubscribeTreasury();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[Indexer] SIGINT received, shutting down gracefully');
    indexerHealth.isRunning = false;
    unsubscribeFactory();
    unsubscribeTreasury();
    process.exit(0);
  });

  indexerHealth.isRunning = true;

  while (indexerHealth.isRunning) {
    try {
      const next = await pollOnce(lastProcessed);
      const madeProgress = next !== lastProcessed;
      lastProcessed = next;

      indexerHealth.consecutiveFailures = 0;
      indexerHealth.lastError = null;
      indexerHealth.lastErrorAt = null;
      indexerHealth.lastSuccessfulPollAt = new Date().toISOString();

      if (!madeProgress) {
        await sleep(pollInterval);
      }
    } catch (err) {
      indexerHealth.consecutiveFailures++;
      indexerHealth.lastError = err instanceof Error ? err.message : String(err);
      indexerHealth.lastErrorAt = new Date().toISOString();

      const backoffMs = calculateBackoff(indexerHealth.consecutiveFailures);
      console.error(
        `[Indexer] Poll failed (consecutive failures: ${indexerHealth.consecutiveFailures}), retrying in ${backoffMs}ms:`,
        err,
      );
      await sleep(backoffMs);
    }
  }
}

export async function pollOnce(lastProcessed: number): Promise<number> {
  const latestLedgerResponse = await server.getLatestLedger();
  const latestLedger = latestLedgerResponse.sequence;

  if (latestLedger < lastProcessed) {
    console.warn(
      `[Indexer] Re-org detected: latest ledger ${latestLedger} is behind ` +
      `last processed ${lastProcessed}. Resuming from tip without replaying backward.`,
    );
    await saveCheckpoint(latestLedger);
    return latestLedger;
  }

  try {
    const fromLedger = await getTrackerLastProcessed();
    const ranges = await getProcessedRanges();
    const missing = findMissingRanges(fromLedger + 1, latestLedger, ranges);
    for (const range of missing) {
      console.log(`[Indexer] Backfilling missing ledgers ${range.start}–${range.end}`);
      await backfillAndRecord(range.start, range.end);
      lastProcessed = Math.max(lastProcessed, range.end);
    }
  } catch (err) {
    // Fallback if table not ready
  }

  for (let seq = lastProcessed + 1; seq <= latestLedger; seq++) {
    try {
      await processLedger(seq);
    } catch (err) {
      if (isLedgerRangeError(err)) {
        console.warn(`[Indexer] Ledger ${seq} unavailable (pruned/out of range), skipping`, err);
      } else {
        throw err;
      }
    }
    await saveCheckpoint(seq);
    lastProcessed = seq;
  }

  return lastProcessed;
}

async function backfillAndRecord(from: number, to: number): Promise<void> {
  for (let seq = from; seq <= to; seq++) {
    await processLedger(seq);
  }
  await recordProcessedRange(from, to);
}

// ---------------------------------------------------------------------------
// ScVal helpers
// ---------------------------------------------------------------------------

function scvToString(scv: xdr.ScVal): string {
  const s = scv as any;
  const arm: string = s.arm();
  switch (arm) {
    case 'sym':   return s.sym().toString();
    case 'str':   return s.str().toString();
    case 'u32':
    case 'i32':
    case 'u64':
    case 'i64':
    case 'b':     return String(s[arm]());
    case 'address': return Address.fromScVal(scv).toString();
    case 'void':  return '';
    default: {
      if (arm === 'i128' || arm === 'u128') {
        const parts = s[arm]();
        const hi = BigInt(parts._attributes?._value ?? 0);
        const lo = BigInt(parts._maxDepth?._value ?? 0);
        const signedHi = arm === 'i128' && hi >= 2n ** 63n ? hi - 2n ** 64n : hi;
        return ((signedHi << 64n) + lo).toString();
      }
      const val = s[arm]?.();
      return val != null ? String(val) : scv.toString();
    }
  }
}

function scvToNative(scv: xdr.ScVal): unknown {
  const s = scv as any;
  const arm: string = s.arm();
  switch (arm) {
    case 'sym':   return s.sym().toString();
    case 'str':   return s.str().toString();
    case 'b':     return s.b();
    case 'u32':   return s.u32();
    case 'i32':   return s.i32();
    case 'u64':   return String(s.u64());
    case 'i64':   return String(s.i64());
    case 'address': return Address.fromScVal(scv).toString();
    case 'void':  return null;
    case 'vec':   return s.vec().map(scvToNative);
    case 'map': {
      const result: Record<string, unknown> = {};
      s.map().forEach((entry: any) => {
        result[String(scvToNative(entry.key()))] = scvToNative(entry.val());
      });
      return result;
    }
    case 'i128':
    case 'u128': {
      const parts = s[arm]();
      const hi = BigInt(parts._attributes?._value ?? 0);
      const lo = BigInt(parts._maxDepth?._value ?? 0);
      const signedHi = arm === 'i128' && hi >= 2n ** 63n ? hi - 2n ** 64n : hi;
      return ((signedHi << 64n) + lo).toString();
    }
    default:      return scv.toString();
  }
}

const EVENT_FIELD_MAP: Record<string, Array<[string, string]>> = {
  market_created: [
    ['market_id',       'topic.1'],
    ['contract_address','data.0'],
    ['match_id',        'data.1'],
  ],
  market_locked: [
    ['market_id', 'topic.1'],
  ],
  market_resolved: [
    ['market_id',     'topic.1'],
    ['outcome',       'data.0'],
    ['oracle_address','data.1'],
  ],
  bet_placed: [
    ['market_id',       'topic.1'],
    ['bettor_address',  'data.0'],
    ['side',            'data.2'],
    ['amount',          'data.3'],
    ['placed_at',       'data.4'],
    ['claimed',         'data.5'],
  ],
  winnings_claimed: [
    ['market_id',      'topic.1'],
    ['bettor_address', 'data.0'],
    ['payout',         'data.2'],
  ],
  refund_claimed: [
    ['market_id',       'topic.1'],
    ['bettor_address',  'data.0'],
    ['refund_amount',   'data.1'],
  ],
  market_cancelled: [
    ['market_id', 'topic.1'],
  ],
};

function buildEventPayload(
  eventType: string,
  topics: xdr.ScVal[],
  value: xdr.ScVal,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const fields = EVENT_FIELD_MAP[eventType];
  if (!fields) return record;

  const nativeData = scvToNative(value) as unknown[] | string | null;

  for (const [fieldName, selector] of fields) {
    if (selector === 'topic.1') {
      record[fieldName] = topics[1] ? scvToString(topics[1]) : '';
    } else if (selector.startsWith('data.')) {
      const idx = parseInt(selector.slice(5), 10);
      record[fieldName] = Array.isArray(nativeData) ? String(nativeData[idx] ?? '') : '';
    } else if (selector === 'data.to_string') {
      record[fieldName] = typeof nativeData === 'string' ? nativeData : String(nativeData ?? '');
    }
  }

  return record;
}

// ---------------------------------------------------------------------------
// Ledger processing
// ---------------------------------------------------------------------------

export async function processLedger(ledger_sequence: number): Promise<void> {
  const request: rpc.Api.GetEventsRequest = {
    startLedger: ledger_sequence,
    filters: [
      {
        type: 'contract',
        contractIds: [FACTORY_CONTRACT, TREASURY_CONTRACT].filter(id => id),
        topics: [['*']]
      }
    ],
    limit: 100
  };

  const response = await server.getEvents(request);
  if (!response.events || response.events.length === 0) {
    return;
  }

  for (const event of response.events) {
    const contractId = typeof event.contractId === 'string' ? event.contractId : event.contractId?.toString() || '';
    const eventType = (event.topic[0] as any)?.sym()?.toString() || 'unknown';
    const payload = buildEventPayload(eventType, event.topic, event.value);
    const data = JSON.stringify(payload);

    const rawEvent: RawStellarEvent = {
      contract_address: contractId,
      event_type: eventType,
      topics: event.topic.map((t: any) => scvToString(t)),
      data,
      ledger_sequence: event.ledger,
      ledger_close_time: event.ledgerClosedAt,
      tx_hash: event.txHash
    };

    await pool.query(
      `INSERT INTO blockchain_events
         (contract_address, event_type, payload, ledger_sequence, ledger_close_time, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tx_hash) DO UPDATE
         SET contract_address  = EXCLUDED.contract_address,
             event_type        = EXCLUDED.event_type,
             payload           = EXCLUDED.payload,
             ledger_close_time = EXCLUDED.ledger_close_time`,
      [
        rawEvent.contract_address,
        rawEvent.event_type,
        rawEvent.data,
        rawEvent.ledger_sequence,
        rawEvent.ledger_close_time,
        rawEvent.tx_hash
      ]
    );

    await processEvent(rawEvent);
  }
}

export const EVENT_HANDLERS: Record<string, (event: RawStellarEvent) => Promise<void>> = {
  market_created:   (e) => handleMarketCreated(e),
  bet_placed:       (e) => handleBetPlaced(e),
  market_locked:    (e) => handleMarketLocked(e),
  market_resolved:  (e) => handleMarketResolved(e),
  market_cancelled: (e) => handleMarketCancelled(e),
  winnings_claimed: (e) => handleWinningsClaimed(e),
  refund_claimed:   (e) => handleRefundClaimed(e),
};

export async function processEvent(event: RawStellarEvent): Promise<void> {
  try {
    const handler = EVENT_HANDLERS[event.event_type];
    if (handler) {
      await handler(event);
      broadcastIndexedEvent(event);
    } else {
      console.warn(
        `[Indexer] Unknown event type "${event.event_type}" on contract ${event.contract_address} ` +
        `(tx: ${event.tx_hash}, ledger: ${event.ledger_sequence}) — skipping`,
      );
    }
  } catch (err) {
    console.error(`Error processing event ${event.tx_hash}:`, err);
  }
}

function parsePayload(data: string): Record<string, unknown> {
  try { return JSON.parse(data); } catch { return {}; }
}

function broadcastIndexedEvent(event: RawStellarEvent): void {
  const feed = tryGetActivityFeed() || getActivityFeedIfInitialized();
  if (!feed) return;

  const p = parsePayload(event.data);
  const marketId = typeof p.market_id === 'string' ? p.market_id : '';
  if (!marketId) return;

  let activityEvent: ActivityEvent;
  if (event.event_type === 'bet_placed') {
    activityEvent = {
      type: 'trade',
      marketId,
      outcomeId: String(p.side ?? ''),
      side: String(p.side ?? ''),
      sharesAmount: Number(p.amount ?? 0),
      priceBps: 0,
      timestamp: event.ledger_close_time,
    };
  } else if (event.event_type === 'market_resolved') {
    activityEvent = { type: 'resolved', marketId, winningOutcomeId: String(p.outcome ?? '') };
  } else {
    activityEvent = { type: 'market_update', marketId, eventType: event.event_type, data: p };
  }

  feed.publish(activityEvent);
}

export async function handleMarketCreated(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  
  try {
    const marketData = {
      market_id: p.market_id,
      contract_address: event.contract_address,
      match_id: p.match_id ?? '',
      fighter_a: p.fighter_a ?? '',
      fighter_b: p.fighter_b ?? '',
      weight_class: p.weight_class ?? '',
      title_fight: p.title_fight ?? false,
      venue: p.venue ?? '',
      scheduled_at: p.scheduled_at ?? new Date(),
      fee_bps: p.fee_bps ?? 200,
      lock_before_secs: p.lock_before_secs ?? 3600,
      status: 'open',
      ledger_sequence: event.ledger_sequence,
    };

    await pool.query(
      `INSERT INTO markets
         (market_id, contract_address, match_id, fighter_a, fighter_b,
          weight_class, title_fight, venue, scheduled_at, fee_bps, lock_before_secs, status, ledger_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (market_id) DO NOTHING`,
      [
        marketData.market_id,
        marketData.contract_address,
        marketData.match_id,
        marketData.fighter_a,
        marketData.fighter_b,
        marketData.weight_class,
        marketData.title_fight,
        marketData.venue,
        marketData.scheduled_at,
        marketData.fee_bps,
        marketData.lock_before_secs,
        marketData.status,
        marketData.ledger_sequence,
      ],
    );

    console.log(`[Indexer] Market created: ${marketData.market_id}`);
  } catch (err) {
    console.error(`[Indexer] Error handling MarketCreated event:`, err);
    throw err;
  }
}

export async function handleBetPlaced(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO bets
         (market_id, bettor_address, side, amount, amount_xlm, placed_at, tx_hash, ledger_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        p.market_id,
        p.bettor_address,
        p.side,
        p.amount,
        Number(p.amount) / 10_000_000,
        p.placed_at ?? new Date(),
        event.tx_hash,
        event.ledger_sequence,
      ],
    );
    const col = p.side === 'fighter_a' ? 'pool_a' : p.side === 'fighter_b' ? 'pool_b' : 'pool_draw';
    const { rows: [pools] } = await client.query(
      `UPDATE markets
          SET ${col}      = ${col} + $1,
              total_pool  = total_pool + $1,
              updated_at  = NOW()
        WHERE market_id   = $2
        RETURNING ${col} AS side_pool, total_pool`,
      [p.amount, p.market_id],
    );
    await client.query('COMMIT');

    const totalPool = Number(pools?.total_pool ?? 0);
    const sidePool = Number(pools?.side_pool ?? 0);
    publishActivity({
      type: 'trade',
      marketId: String(p.market_id),
      outcomeId: String(p.side),
      side: String(p.side),
      sharesAmount: Number(p.amount),
      priceBps: totalPool > 0 ? Math.round((sidePool / totalPool) * 10_000) : 0,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function handleMarketLocked(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  await pool.query(
    `UPDATE markets SET status = 'locked', updated_at = NOW() WHERE market_id = $1`,
    [p.market_id],
  );
}

export async function handleMarketResolved(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  const outcome = typeof p.outcome === 'string' ? p.outcome : null;
  const marketId = typeof p.market_id === 'string' ? p.market_id : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const matchId = typeof p.match_id === 'string' ? p.match_id : null;
    const oracleAddress = typeof p.oracle_address === 'string' ? p.oracle_address : null;
    const signature = typeof p.signature === 'string' ? p.signature : null;
    const resolvedAt = event.ledger_close_time ?? new Date().toISOString();

    if (!marketId) {
      throw new Error('Missing market_id in MarketResolved event');
    }

    await client.query(
      `UPDATE markets
          SET status = 'resolved', outcome = $1, resolved_at = $2, oracle_used = $3, updated_at = NOW()
        WHERE market_id = $4`,
      [outcome, resolvedAt, oracleAddress ?? null, marketId],
    );

    await client.query(
      `INSERT INTO oracle_reports
         (match_id, oracle_address, outcome, reported_at, signature, accepted, tx_hash)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       ON CONFLICT DO NOTHING`,
      [
        matchId ?? '',
        oracleAddress ?? '',
        outcome ?? '',
        resolvedAt,
        signature ?? '',
        event.tx_hash,
      ],
    );

    const { rows: bettors } = await client.query(
      `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`,
      [marketId]
    );

    for (const bettor of bettors) {
      await client.query(
        `INSERT INTO notification_jobs (bettor_address, market_id, job_type, status, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [bettor.bettor_address, marketId, 'market_resolved', 'pending']
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await cacheDeletePattern(`market:${marketId}*`);
  await cacheDeletePattern(`markets:*`);

  if (marketId) {
    publishActivity({ type: 'resolved', marketId, winningOutcomeId: outcome ?? '' });
  }
}

export async function handleMarketCancelled(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE markets SET status = 'cancelled', updated_at = NOW() WHERE market_id = $1`,
      [p.market_id],
    );

    const { rows: bettors } = await client.query(
      `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`,
      [p.market_id]
    );

    for (const bettor of bettors) {
      await client.query(
        `INSERT INTO notification_jobs (bettor_address, market_id, job_type, status, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [bettor.bettor_address, p.market_id, 'market_cancelled', 'pending']
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (typeof p.market_id === 'string') {
    publishActivity({ type: 'cancelled', marketId: p.market_id });
  }
}

export async function handleWinningsClaimed(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  await pool.query(
    `UPDATE bets
        SET claimed = TRUE, claimed_at = NOW(), payout = $1
      WHERE market_id = $2 AND bettor_address = $3`,
    [p.payout ?? null, p.market_id, p.bettor_address],
  );
}

export async function handleRefundClaimed(event: RawStellarEvent): Promise<void> {
  const p = parsePayload(event.data);
  await pool.query(
    `UPDATE bets
        SET claimed = TRUE, claimed_at = NOW(), payout = $1
      WHERE market_id = $2 AND bettor_address = $3`,
    [p.refund_amount ?? null, p.market_id, p.bettor_address],
  );
}

export async function getLastProcessedLedger(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT last_processed_ledger FROM indexer_checkpoints ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.last_processed_ledger ?? Number(process.env.GENESIS_LEDGER ?? 0);
}

export async function saveCheckpoint(ledger_sequence: number): Promise<void> {
  await pool.query(
    `INSERT INTO indexer_checkpoints (id, last_processed_ledger)
     VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE
       SET last_processed_ledger = EXCLUDED.last_processed_ledger,
           updated_at = NOW()`,
    [ledger_sequence],
  );
}

export async function backfillLedgerRange(
  from_ledger: number,
  to_ledger: number,
  batch_size: number,
): Promise<void> {
  const total = to_ledger - from_ledger + 1;
  console.log(
    `[Backfill] Starting — ledgers ${from_ledger}–${to_ledger} ` +
    `(${total} ledgers, batch_size=${batch_size})`,
  );

  let processed = 0;

  for (let batchStart = from_ledger; batchStart <= to_ledger; batchStart += batch_size) {
    const batchEnd = Math.min(batchStart + batch_size - 1, to_ledger);

    for (let seq = batchStart; seq <= batchEnd; seq++) {
      try {
        await processLedger(seq);
      } catch (err) {
        console.error(
          `[Backfill] Failed to process ledger ${seq}, skipping:`,
          err instanceof Error ? err.message : err,
        );
      }
      processed++;

      if (processed % 1_000 === 0) {
        const pct = ((processed / total) * 100).toFixed(1);
        console.log(
          `[Backfill] Progress: ${processed}/${total} ledgers processed ` +
          `(${pct}%, current ledger: ${seq})`,
        );
      }
    }

    await recordProcessedRange(batchStart, batchEnd);
  }

  console.log(`[Backfill] Complete — ${processed} ledgers processed.`);
}

export async function loadCheckpoint(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT last_processed_ledger FROM indexer_checkpoints ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.last_processed_ledger ?? null;
}

export async function backfillFromLedger(fromLedger: number, toLedger?: number): Promise<void> {
  console.log(`[Indexer] Backfilling from ledger ${fromLedger}${toLedger ? ` to ${toLedger}` : ''}`);
  
  const events = await fetchHistoricalEvents(fromLedger, toLedger);
  console.log(`[Indexer] Fetched ${events.length} historical events`);

  for (const event of events) {
    await processEvent(event);
  }

  if (toLedger) {
    await recordProcessedRange(fromLedger, toLedger);
  }
}
