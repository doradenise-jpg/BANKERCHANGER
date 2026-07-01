import { rpc, scValToNative } from '@stellar/stellar-sdk';
import { getCursor, saveCursor, upsertInvoice } from './db';
import { updateLastLedger } from './health';
import dotenv from 'dotenv';

dotenv.config();

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
}

let pollerHealth: PollerHealth = {
  isRunning: false,
  consecutiveFailures: 0,
  lastError: null,
  lastErrorAt: null,
  lastSuccessfulPollAt: null,
  eventsProcessed: 0,
};

export function getPollerHealth(): PollerHealth {
  return { ...pollerHealth };
}

// ── Exponential backoff strategy ────────────────────────────────────────────
const MIN_BACKOFF_MS = 1000;      // 1 second
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
const BACKOFF_MULTIPLIER = 2;

function calculateBackoff(failureCount: number): number {
  const backoff = MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, failureCount - 1);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

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

  // Recursive async loop with exponential backoff
  async function pollLoop(): Promise<void> {
    try {
      // Build request
      const request: rpc.Api.GetEventsRequest = cursor
        ? {
            cursor,
            filters: [
              {
                type: 'contract',
                contractIds: [CONTRACT_ID],
                topics: [['*']]
              }
            ],
            limit: 100
          }
        : {
            startLedger: await getLatestLedger(),
            filters: [
              {
                type: 'contract',
                contractIds: [CONTRACT_ID],
                topics: [['*']]
              }
            ],
            limit: 100
          };

      // Poll for events
      const response = await server.getEvents(request);

      // Process events only if successful
      if (response.events && response.events.length > 0) {
        for (const event of response.events) {
          processEvent(event);
          // Update last ledger from event
          if (event.ledger) {
            updateLastLedger(event.ledger);
          }
        }
        // Only advance cursor on successful poll
        const oldCursor = cursor;
        cursor = response.cursor;
        await saveCursor(cursor);
        pollerHealth.eventsProcessed += response.events.length;

        log('info', 'Events polled and processed', {
          eventCount: response.events.length,
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

      const backoffMs = calculateBackoff(pollerHealth.consecutiveFailures);

      log('error', 'Poll failed, scheduling retry', {
        error: pollerHealth.lastError,
        consecutiveFailures: pollerHealth.consecutiveFailures,
        backoffMs,
        cursor,
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

export function processEvent(event: rpc.Api.EventResponse) {
  // Topics are scVals, typically symbol strings
  const topics = event.topic.map(t => {
    try {
      return scValToNative(t);
    } catch {
      return null;
    }
  });

  const eventType = topics[0]; // e.g. 'submitted', 'funded', 'paid', 'defaulted'
  if (!eventType) return;

  try {
    const data = scValToNative(event.value);
    
    // Assume data contains { id, freelancer, payer, amount, dueDate } for 'submitted'
    // and just { id } for status changes. This is dependent on contract implementation.
    
    if (eventType === 'submitted') {
      upsertInvoice({
        id: data.id,
        freelancer: data.freelancer || '',
        payer: data.payer || '',
        amount: data.amount || 0,
        due_date: data.dueDate || new Date().toISOString(),
        status: 'Pending'
      });
      log('info', 'Processed event: submitted', { invoiceId: data.id });
    } else if (eventType === 'funded') {
      upsertInvoice({
        id: data.id || data,
        freelancer: '', payer: '', amount: 0, due_date: '',
        status: 'Funded'
      });
      log('info', 'Processed event: funded', { invoiceId: data.id || data });
    } else if (eventType === 'paid') {
      upsertInvoice({
        id: data.id || data,
        freelancer: '', payer: '', amount: 0, due_date: '',
        status: 'Paid'
      });
      log('info', 'Processed event: paid', { invoiceId: data.id || data });
    } else if (eventType === 'defaulted') {
      upsertInvoice({
        id: data.id || data,
        freelancer: '', payer: '', amount: 0, due_date: '',
        status: 'Defaulted'
      });
      log('info', 'Processed event: defaulted', { invoiceId: data.id || data });
    }
  } catch (err) {
    log('error', 'Failed to process event', {
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
