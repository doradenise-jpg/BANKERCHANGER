import { rpc, scValToNative } from '@stellar/stellar-sdk';
import { getCursor, saveCursor, getLastKnownLedger, upsertInvoice, saveEventsAndCursorAtomic } from './db';
import { updateLastLedger } from './health';
import { detectLedgerAnomaly, computeResyncStartLedger } from './ledgerContinuity';
import { calculateBackoff, loadBackoffConfigFromEnv } from './backoff';
import { broadcast } from './ws';
import dotenv from 'dotenv';

dotenv.config();

export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCH_SIZE = 500;

export function resolveBatchSize(envVal: string | undefined = process.env.INDEXER_BATCH_SIZE): number {
  if (!envVal) return DEFAULT_BATCH_SIZE;
  const parsed = parseInt(envVal, 10);
  if (isNaN(parsed) || parsed <= 0) {
    console.warn(`[WARN] Invalid INDEXER_BATCH_SIZE="${envVal}", falling back to default ${DEFAULT_BATCH_SIZE}`);
    return DEFAULT_BATCH_SIZE;
  }
  if (parsed > MAX_BATCH_SIZE) {
    console.warn(`[WARN] INDEXER_BATCH_SIZE ${parsed} exceeds maximum ${MAX_BATCH_SIZE}; capping at ${MAX_BATCH_SIZE}`);
    return MAX_BATCH_SIZE;
  }
  return parsed;
}

export function computeEffectiveBatchSize(ledgerLag: number): number {
  const baseSize = resolveBatchSize();
  if (ledgerLag > 1000) {
    return MAX_BATCH_SIZE;
  }
  return baseSize;
}

const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.FACTORY_CONTRACT_ADDRESS;

if (!CONTRACT_ID) {
  throw new Error('FACTORY_CONTRACT_ADDRESS environment variable is not set. Cannot initialize indexer.');
}

const server = new rpc.Server(RPC_URL);

// ── Polling state for health monitoring ────────────────────────────────────
interface PollerHealth {
  isRunning: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessfulPollAt: string | null;
  eventsProcessed: number;
  reorgsDetected: number;
  lastReorgAt: string | null;
  ledgerGapsDetected: number;
  lastLedgerGapAt: string | null;
}

let pollerHealth: PollerHealth = {
  isRunning: false,
  consecutiveFailures: 0,
  lastError: null,
  lastErrorAt: null,
  lastSuccessfulPollAt: null,
  eventsProcessed: 0,
  reorgsDetected: 0,
  lastReorgAt: null,
  ledgerGapsDetected: 0,
  lastLedgerGapAt: null,
};

export function getPollerHealth(): PollerHealth {
  return { ...pollerHealth };
}

// ── Duplicate events skipped metric (Issue #687) ───────────────────────────
export let indexer_duplicate_events_skipped_total = 0;

export function getIndexerDuplicateEventsSkippedTotal(): number {
  return indexer_duplicate_events_skipped_total;
}

export function resetIndexerDuplicateEventsSkippedTotal(): void {
  indexer_duplicate_events_skipped_total = 0;
}

// ── Exponential backoff strategy (tunable via POLLER_*_BACKOFF_MS env vars) ─
const BACKOFF_CONFIG = loadBackoffConfigFromEnv();

// ── Structured logging ──────────────────────────────────────────────────────
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

function log(level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context,
  };
  console.log(JSON.stringify(entry));
}

export async function pollEvents() {
  log('info', 'Indexer poller started', { contractId: CONTRACT_ID, rpcUrl: RPC_URL });
  pollerHealth.isRunning = true;

  let cursor = (await getCursor()) || '';
  // Last ledger sequence we successfully processed, used to detect re-orgs
  // (ledger sequence moving backward) and gaps (skipped sequences) across polls.
  let lastProcessedLedger: number | null = await getLastKnownLedger();
  // Set when a re-org is detected; forces the next request to resync from a
  // safe ledger instead of trusting the (possibly now-invalid) cursor.
  let pendingResyncLedger: number | null = null;

  // ── Graceful shutdown handlers ──────────────────────────────────────────
  // Save cursor before exit to avoid re-processing events on restart
  const handleShutdown = async (signal: string) => {
    log('info', `${signal} received, saving cursor and exiting gracefully`, { cursor });
    pollerHealth.isRunning = false;
    try {
      await saveCursor(cursor);
      log('info', 'Cursor saved successfully', { cursor });
    } catch (err) {
      log('error', 'Failed to save cursor during graceful shutdown', {
        error: err instanceof Error ? err.message : String(err),
        cursor,
      });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  // Recursive async loop with exponential backoff
  async function pollLoop(): Promise<void> {
    try {
      // A pending resync (set after a re-org) always takes priority over the
      // persisted cursor, since the cursor may point past ledgers that no
      // longer exist on the canonical chain.
      const resyncLedger = pendingResyncLedger;
      pendingResyncLedger = null;
      if (resyncLedger !== null) {
        cursor = '';
      }

      const latestLedger = await getLatestLedger().catch(() => lastProcessedLedger ?? 0);
      const lag = Math.max(0, latestLedger - (lastProcessedLedger ?? latestLedger));
      const batchLimit = computeEffectiveBatchSize(lag);

      // Build request with proper typing (use any to bypass strict filter type checking)
      const request: any = (cursor && resyncLedger === null)
        ? {
            cursor,
            filters: [
              {
                type: 'contract',
                contractIds: [CONTRACT_ID],
                topics: [['*']]
              }
            ],
            limit: batchLimit
          }
        : {
            startLedger: resyncLedger ?? latestLedger,
            filters: [
              {
                type: 'contract',
                contractIds: [CONTRACT_ID],
                topics: [['*']]
              }
            ],
            limit: batchLimit
          };

      // Poll for events with pagination support
      let paginationCursor = cursor || '';
      let totalEventsProcessed = 0;
      let hasMore = true;
      let reorgTriggered = false;

      while (hasMore) {
        // Build paginated request
        const filters = request.filters || [
          {
            type: 'contract',
            contractIds: [CONTRACT_ID],
            topics: [['*']]
          }
        ];

        // Build request with proper typing
        let paginatedRequest: any = {
          filters,
          limit: batchLimit,
        };

        // Set cursor or startLedger
        if (paginationCursor) {
          paginatedRequest.cursor = paginationCursor;
        } else if (request.startLedger) {
          paginatedRequest.startLedger = request.startLedger;
        }

        const response = await server.getEvents(paginatedRequest);

        // Process all events on this page grouped by ledger sequence
        if (response.events && response.events.length > 0) {
          const eventsByLedger: Map<number, rpc.Api.EventResponse[]> = new Map();
          for (const event of response.events) {
            const l = event.ledger || 0;
            if (!eventsByLedger.has(l)) eventsByLedger.set(l, []);
            eventsByLedger.get(l)!.push(event);
          }

          for (const [eventLedger, ledgerEvents] of eventsByLedger) {
            if (eventLedger > 0) {
              const anomaly = detectLedgerAnomaly(eventLedger, lastProcessedLedger);

              if (anomaly.type === 'reorg') {
                pollerHealth.reorgsDetected++;
                pollerHealth.lastReorgAt = new Date().toISOString();
                log('warn', 'Ledger re-org detected; discarding cursor and re-syncing from a safe ledger', {
                  lastProcessedLedger: anomaly.fromLedger,
                  incomingEventLedger: anomaly.toLedger,
                });
                broadcast({
                  type: 'poller.reorg_detected',
                  timestamp: new Date().toISOString(),
                  data: { lastProcessedLedger: anomaly.fromLedger, incomingEventLedger: anomaly.toLedger },
                });
                // Don't trust or process events from a superseded ledger view.
                // Rewind and let the next poll iteration re-fetch canonical events.
                pendingResyncLedger = computeResyncStartLedger(anomaly.fromLedger);
                reorgTriggered = true;
                break;
              }

              if (anomaly.type === 'gap') {
                pollerHealth.ledgerGapsDetected++;
                pollerHealth.lastLedgerGapAt = new Date().toISOString();
                log('warn', 'Missing ledger sequence(s) detected between polls', {
                  fromLedger: anomaly.fromLedger,
                  toLedger: anomaly.toLedger,
                  missingCount: anomaly.missingCount,
                });
              }
            }

            // Commit all events in this ledger first
            for (const event of ledgerEvents) {
              processEvent(event);
            }

            // Last processed ledger saved ONLY after all events in that ledger are committed (Issue #687)
            if (eventLedger > 0) {
              lastProcessedLedger = eventLedger;
              updateLastLedger(eventLedger);
            }
          }

          if (!reorgTriggered) {
            totalEventsProcessed += response.events.length;
          }
        }

        if (reorgTriggered) {
          // Skip cursor persistence entirely this round; pendingResyncLedger
          // drives the next iteration's request instead.
          hasMore = false;
          break;
        }

        // Check if there are more pages using paging_token (the cursor field)
        // Stellar RPC uses paging_token for pagination; if it exists and events were returned,
        // there may be more data
        const pagingToken = (response as any).paging_token;
        if (pagingToken && response.events && response.events.length > 0) {
          paginationCursor = pagingToken;
          hasMore = true;
        } else {
          hasMore = false;
          // Only advance main cursor when all pages are consumed
          const oldCursor = cursor;
          cursor = response.cursor || pagingToken || '';
          await saveCursor(cursor, lastProcessedLedger ?? undefined);
          pollerHealth.eventsProcessed += totalEventsProcessed;

          if (totalEventsProcessed > 0) {
            log('info', 'Events polled and processed (with pagination)', {
              eventCount: totalEventsProcessed,
              oldCursor,
              newCursor: cursor,
              consecutiveFailures: pollerHealth.consecutiveFailures,
            });
          } else {
            log('info', 'Poll successful but no new events', {
              cursor,
              consecutiveFailures: pollerHealth.consecutiveFailures,
            });
          }
        }
      }

      // Reset failure counter on success
      pollerHealth.consecutiveFailures = 0;
      pollerHealth.lastError = null;
      pollerHealth.lastErrorAt = null;
      pollerHealth.lastSuccessfulPollAt = new Date().toISOString();

      // Schedule next poll immediately (no fixed interval, just loop)
      await new Promise(resolve => setImmediate(resolve));
      await pollLoop();

    } catch (err) {
      pollerHealth.consecutiveFailures++;
      pollerHealth.lastError = err instanceof Error ? err.message : String(err);
      pollerHealth.lastErrorAt = new Date().toISOString();

      const backoffMs = calculateBackoff(pollerHealth.consecutiveFailures, BACKOFF_CONFIG);

      log('error', 'Poll failed, scheduling retry', {
        error: pollerHealth.lastError,
        consecutiveFailures: pollerHealth.consecutiveFailures,
        backoffMs,
        cursor,
      });

      broadcast({
        type: 'poller.retry_scheduled',
        timestamp: new Date().toISOString(),
        data: { consecutiveFailures: pollerHealth.consecutiveFailures, backoffMs },
      });

      // Wait with exponential backoff before retrying
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      await pollLoop();
    }
  }

  // Start the polling loop
  pollLoop().catch(err => {
    log('error', 'Polling loop terminated with unrecoverable error', {
      error: err instanceof Error ? err.message : String(err),
    });
    pollerHealth.isRunning = false;
    process.exit(1);
  });
}

async function getLatestLedger(): Promise<number> {
  try {
    const health = await server.getLatestLedger();
    return health.sequence;
  } catch (err) {
    log('error', 'Failed to get latest ledger', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Return a conservative starting point
    return 1;
  }
}

export function processEvent(event: rpc.Api.EventResponse): boolean {
  // Topics are scVals, typically symbol strings
  const topics = event.topic.map((t: any) => {
    try {
      return scValToNative(t);
    } catch {
      return null;
    }
  });

  const eventType = topics[0]; // e.g. 'submitted', 'funded', 'paid', 'defaulted'
  if (!eventType) return false;

  const txHash = (event as any).txHash || (event as any).id || (event as any).pagingToken || `evt-${event.ledger ?? 0}-${Date.now()}`;
  const eventIndex = (event as any).eventIndex ?? (event as any).inTxOrder ?? 0;

  // Deduplicate event using INSERT ... ON CONFLICT (tx_hash, event_index) DO NOTHING (Issue #687)
  const isNew = recordProcessedEvent(
    txHash,
    eventIndex,
    String(eventType),
    event.ledger,
    JSON.stringify(event.value),
  );
  if (!isNew) {
    indexer_duplicate_events_skipped_total++;
    log('info', 'Duplicate event skipped across restarts', {
      txHash,
      eventIndex,
      eventType,
      ledger: event.ledger,
    });
    return false;
  }

  try {
    const data = scValToNative(event.value);
    
    // Assume data contains { id, freelancer, payer, amount, dueDate } for 'submitted'
    // and just { id } for status changes. This is dependent on contract implementation.
    
    if (eventType === 'submitted') {
      const invoiceId = data.id;
      upsertInvoice({
        id: invoiceId,
        freelancer: data.freelancer || '',
        payer: data.payer || '',
        amount: data.amount || 0,
        due_date: data.dueDate || new Date().toISOString(),
        status: 'Pending'
      });
      log('info', 'Processed event: submitted', { invoiceId });
      broadcast({ type: 'invoice.submitted', timestamp: new Date().toISOString(), data: { invoiceId } });
    } else if (eventType === 'funded') {
      const invoiceId = data.id || data;
      upsertInvoice({
        id: invoiceId,
        freelancer: '', payer: '', amount: 0, due_date: '',
        status: 'Funded'
      });
      log('info', 'Processed event: funded', { invoiceId });
      broadcast({ type: 'invoice.funded', timestamp: new Date().toISOString(), data: { invoiceId } });
    } else if (eventType === 'paid') {
      const invoiceId = data.id || data;
      upsertInvoice({
        id: invoiceId,
        freelancer: '', payer: '', amount: 0, due_date: '',
        status: 'Paid'
      });
      log('info', 'Processed event: paid', { invoiceId });
      broadcast({ type: 'invoice.paid', timestamp: new Date().toISOString(), data: { invoiceId } });
    } else if (eventType === 'defaulted') {
      const invoiceId = data.id || data;
      upsertInvoice({
        id: invoiceId,
        freelancer: '', payer: '', amount: 0, due_date: '',
        status: 'Defaulted'
      });
      log('info', 'Processed event: defaulted', { invoiceId });
      broadcast({ type: 'invoice.defaulted', timestamp: new Date().toISOString(), data: { invoiceId } });
    }
  } catch (err) {
    log('error', 'Failed to process event', {
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
