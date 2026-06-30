// ============================================================
// BOXMEOUT — Stellar Blockchain Indexer
//
// Listens to the Stellar network for contract events emitted
// by MarketFactory, Market, and Treasury contracts.
// Persists all relevant state changes to the PostgreSQL DB.
//
// Contributors: implement every function marked TODO.
// DO NOT change function signatures.
// ============================================================

import { pool } from '../config/db';
import { rpc, Address, xdr } from '@stellar/stellar-sdk';
import { subscribeToContractEvents, fetchHistoricalEvents } from '../services/StellarService';
import { RawStellarEvent, StellarEventProcessor } from './EventProcessor';

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const FACTORY_CONTRACT = process.env.FACTORY_CONTRACT_ADDRESS || '';
const TREASURY_CONTRACT = process.env.TREASURY_CONTRACT_ADDRESS || '';

const server = new rpc.Server(RPC_URL);
const eventProcessor = new StellarEventProcessor();

export async function startIndexer(): Promise<void> {
  const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  let lastProcessed = await getLastProcessedLedger();

  console.log(`[Indexer] Starting from ledger ${lastProcessed}`);

  // Load checkpoint and backfill if needed
  const checkpoint = await loadCheckpoint();
  if (checkpoint && checkpoint > lastProcessed) {
    console.log(`[Indexer] Backfilling from ledger ${lastProcessed + 1} to ${checkpoint}`);
    await backfillFromLedger(lastProcessed + 1, checkpoint);
    lastProcessed = checkpoint;
  }

  // Subscribe to real-time events
  console.log(`[Indexer] Starting real-time subscription from ledger ${lastProcessed}`);
  const unsubscribe = subscribeToContractEvents(FACTORY_CONTRACT, async (event: unknown) => {
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
  });

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[Indexer] SIGTERM received, shutting down gracefully');
    unsubscribe();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[Indexer] SIGINT received, shutting down gracefully');
    unsubscribe();
    process.exit(0);
  });

  // Keep polling for new ledgers as fallback
  while (true) {
    try {
      const latestLedgerResponse = await server.getLatestLedger();
      const latestLedger = latestLedgerResponse.sequence;

      if (latestLedger > lastProcessed) {
        for (let seq = lastProcessed + 1; seq <= latestLedger; seq++) {
          await processLedger(seq);
          await saveCheckpoint(seq);
          lastProcessed = seq;
        }
      } else {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    } catch (err) {
      console.error('[Indexer] Unrecoverable error:', err);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// ScVal helpers
// ---------------------------------------------------------------------------

/** Safely extract a string value from an xdr.ScVal. */
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

/** Recursively convert an xdr.ScVal to a plain JS value. */
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

/**
 * Map of Soroban event type (snake_case) → flat JSON field selectors.
 *
 * Each entry lists the fields expected by the handler and how to extract them
 * from the ScVal topics/value. The selectors use dot‑separated paths:
 *   "topic.1"       → topic at index 1 (market_id)
 *   "data.0"        → data array at index 0 (first field of the tuple/struct)
 *   "data.to_string" → data as a plain string (not an array)
 */
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

/**
 * Build a flat JSON record from ScVal topics and value for a given event type.
 *
 * The returned record is then JSON.stringify'd into RawStellarEvent.data
 * so that existing handlers (which call parsePayload) can read by field name.
 */
function buildEventPayload(
  eventType: string,
  topics: xdr.ScVal[],
  value: xdr.ScVal,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const fields = EVENT_FIELD_MAP[eventType];
  if (!fields) return record; // unknown event → empty record

  // Decode the data value (mostly a Vec or single value)
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
  try {
    const request: rpc.Api.GetEventsRequest = {
      startLedger: ledger_sequence,
      filters: [
        {
          type: 'contract',
          contractIds: [FACTORY_CONTRACT, TREASURY_CONTRACT],
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

      // Properly extract event type from ScVal Symbol topic
      const eventType = (event.topic[0] as any)?.sym()?.toString() || 'unknown';

      // Build a flat JSON record from ScVal topics + value
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

      // Persist raw event to blockchain_events table — use DO UPDATE so
      // re-indexing during a backfill refreshes stale rows instead of skipping.
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

      // Process the event
      await processEvent(rawEvent);
    }
  } catch (err) {
    console.error(`Error processing ledger ${ledger_sequence}:`, err);
  }
}

export async function processEvent(event: RawStellarEvent): Promise<void> {
  await eventProcessor.process(event);
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

/**
 * Backfills all ledgers in [from_ledger, to_ledger] inclusive.
 *
 * - Processes ledgers in ascending order.
 * - Fetches events in batches of `batch_size` to avoid memory pressure.
 * - Uses ON CONFLICT DO UPDATE (via processLedger) so re-runs are safe.
 * - Logs progress every 1 000 ledgers and emits a completion summary.
 */
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
      await processLedger(seq);
      processed++;

      if (processed % 1_000 === 0) {
        const pct = ((processed / total) * 100).toFixed(1);
        console.log(
          `[Backfill] Progress: ${processed}/${total} ledgers processed ` +
          `(${pct}%, current ledger: ${seq})`,
        );
      }
    }

    // Persist checkpoint after every batch so a restart only re-does the last batch
    await saveCheckpoint(batchEnd);
  }

  console.log(`[Backfill] Complete — ${processed} ledgers processed.`);
}

/**
 * Loads the checkpoint from the database.
 * Returns the last processed ledger, or null if no checkpoint exists.
 */
export async function loadCheckpoint(): Promise<number | null> {
  const { rows } = await pool.query(
    `SELECT last_processed_ledger FROM indexer_checkpoints ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.last_processed_ledger ?? null;
}

/**
 * Backfills from a given ledger to the latest ledger.
 * Uses fetchHistoricalEvents to get all events and processes them.
 */
export async function backfillFromLedger(fromLedger: number, toLedger?: number): Promise<void> {
  console.log(`[Indexer] Backfilling from ledger ${fromLedger}${toLedger ? ` to ${toLedger}` : ''}`);
  
  const events = await fetchHistoricalEvents(fromLedger, toLedger);
  console.log(`[Indexer] Fetched ${events.length} historical events`);

  for (const event of events) {
    await processEvent(event);
  }

  if (toLedger) {
    await saveCheckpoint(toLedger);
  }
}
