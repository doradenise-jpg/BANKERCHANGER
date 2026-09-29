import { rpc, scValToNative } from "@stellar/stellar-sdk";
import { getCursor, saveCursor, upsertInvoice } from "./db";
import { updateLastLedger } from "./health";
import { logger } from "./logger";
import dotenv from "dotenv";

dotenv.config();

// ─── Types ───────────────────────────────────────────────────────────────────

interface EventBatchConfig {
  batchSize: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export interface ProcessedEvent {
  type: string;
  contractId: string;
  ledgerSequence: number;
  eventType: string;
  value: any;
  processedAt: string;
  batchId: number;
}

export interface BatchResult {
  batchId: number;
  startLedger: number;
  endLedger: number;
  eventsProcessed: number;
  errors: string[];
  durationMs: number;
}

export interface DeadLetterEntry {
  event: ProcessedEvent;
  error: string;
  failedAt: string;
  attempts: number;
}

// ─── Known Events & Metrics (#694, #699) ─────────────────────────────────────

export const KNOWN_EVENT_TYPES = new Set([
  "invoice_created",
  "invoice_paid",
  "market_created",
  "bet_placed",
  "market_resolved",
  "liquidity_added",
  "liquidity_removed",
]);

export const indexer_unknown_event_types_total: Record<string, number> = {};
export const deadLetterLog: DeadLetterEntry[] = [];

/**
 * Distinguishes transient DB errors (connection timeouts, busy locks, deadlocks)
 * from permanent non-transient errors (constraint violations, schema mismatch).
 */
export function isTransientDbError(error: any): boolean {
  if (!error) return false;
  const msg = (error.message || String(error)).toLowerCase();
  const code = (error.code || "").toLowerCase();

  // Non-transient errors
  if (
    msg.includes("unique") ||
    msg.includes("constraint") ||
    msg.includes("not null") ||
    msg.includes("foreign key") ||
    code === "sqlite_constraint"
  ) {
    return false;
  }

  // Transient errors
  if (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("connection") ||
    msg.includes("deadlock") ||
    msg.includes("serialization") ||
    msg.includes("busy") ||
    msg.includes("locked") ||
    msg.includes("timeout") ||
    code === "sqlite_busy" ||
    code === "sqlite_locked"
  ) {
    return true;
  }

  return false;
}

// ─── Configuration by Batch ──────────────────────────────────────────────────

const BATCH_CONFIGS: Record<number, EventBatchConfig> = {
  1: { batchSize: 25, maxRetries: 5, baseBackoffMs: 500, maxBackoffMs: 60000 },
  2: { batchSize: 50, maxRetries: 4, baseBackoffMs: 1000, maxBackoffMs: 120000 },
  3: { batchSize: 100, maxRetries: 3, baseBackoffMs: 2000, maxBackoffMs: 300000 },
};

// ─── Event Pipeline ──────────────────────────────────────────────────────────

export async function processEventBatch(
  server: rpc.Server,
  startLedger: number,
  batchId: number,
): Promise<BatchResult> {
  const config = BATCH_CONFIGS[batchId] || BATCH_CONFIGS[1];
  const startTime = Date.now();
  const errors: string[] = [];
  let eventsProcessed = 0;
  let currentLedger = startLedger;

  logger.info({ batchId, startLedger, batchSize: config.batchSize }, "Starting event batch processing");

  try {
    const endLedger = startLedger + config.batchSize - 1;
    const response = await server.getEvents({
      startLedger,
      endLedger,
      limit: 1000,
    });

    for (const event of response.events) {
      try {
        const parsed = parseEvent(event, currentLedger, batchId);
        if (parsed) {
          await handleEvent(parsed);
          eventsProcessed++;
        }
      } catch (error: any) {
        const errorMsg = `Failed to process event at ledger ${currentLedger}: ${error.message}`;
        errors.push(errorMsg);
        logger.error({ err: error, ledger: currentLedger, batchId }, errorMsg);
      }
      currentLedger++;
    }

    await saveCursor(endLedger);
    await updateLastLedger(endLedger);

    return {
      batchId,
      startLedger,
      endLedger,
      eventsProcessed,
      errors,
      durationMs: Date.now() - startTime,
    };
  } catch (error: any) {
    const errorMsg = `Batch ${batchId} failed at ledger ${currentLedger}: ${error.message}`;
    errors.push(errorMsg);
    logger.error({ err: error, batchId, currentLedger }, errorMsg);

    return {
      batchId,
      startLedger,
      endLedger: currentLedger - 1,
      eventsProcessed,
      errors,
      durationMs: Date.now() - startTime,
    };
  }
}

// ─── Event Parsing ───────────────────────────────────────────────────────────

export function parseEvent(event: any, ledgerSequence: number, batchId: number): ProcessedEvent | null {
  try {
    const contractId = event.contractId;
    const eventType = event.type;
    const xdr = event.xdr;

    let value: any = null;
    try {
      if (xdr) {
        value = scValToNative(xdr);
      }
    } catch {
      value = { raw: xdr };
    }

    return {
      type: "contract_event",
      contractId,
      ledgerSequence,
      eventType,
      value,
      processedAt: new Date().toISOString(),
      batchId,
    };
  } catch (error) {
    logger.warn({ err: error, batchId }, "Failed to parse event");
    return null;
  }
}

import { indexerQueueDepth, indexerQueueOverflowTotal } from "./metrics";

// ─── Bounded In-Memory Broadcast Queue ──────────────────────────────────────

export const DEFAULT_MAX_QUEUE_DEPTH = 10000;

export function getMaxQueueDepth(): number {
  const parsed = Number(process.env.MAX_QUEUE_DEPTH);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_QUEUE_DEPTH;
}

const eventBroadcastQueue: ProcessedEvent[] = [];

/** Current queued events awaiting broadcast */
export function getEventQueue(): ProcessedEvent[] {
  return eventBroadcastQueue;
}

/** Number of events currently in the broadcast queue */
export function getEventQueueDepth(): number {
  return eventBroadcastQueue.length;
}

/** Clear the queue (useful in tests and during maintenance) */
export function clearEventQueue(): void {
  eventBroadcastQueue.length = 0;
  indexerQueueDepth.set(0);
}

/**
 * Enqueues a processed event for WebSocket broadcasting.
 * If the queue exceeds MAX_QUEUE_DEPTH, drops the oldest event
 * and emits the indexer_queue_overflow_total metric.
 */
export function enqueueBroadcastEvent(event: ProcessedEvent): boolean {
  const maxDepth = getMaxQueueDepth();
  let dropped = false;

  if (eventBroadcastQueue.length >= maxDepth) {
    eventBroadcastQueue.shift();
    indexerQueueOverflowTotal.inc();
    dropped = true;
    logger.warn(
      { queueDepth: eventBroadcastQueue.length, maxDepth },
      "WebSocket event broadcast queue cap reached, dropping oldest event"
    );
  }

  eventBroadcastQueue.push(event);
  indexerQueueDepth.set(eventBroadcastQueue.length);
  return !dropped;
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

async function handleEvent(event: ProcessedEvent): Promise<void> {
  switch (event.eventType) {
    case "invoice_created":
      await writeWithTransientRetry(() =>
        upsertInvoice({
          contractId: event.contractId,
          ledgerSequence: event.ledgerSequence,
          data: event.value,
        }),
      );
      break;

    case "invoice_paid":
      await writeWithTransientRetry(() =>
        upsertInvoice({
          contractId: event.contractId,
          ledgerSequence: event.ledgerSequence,
          data: { ...event.value, status: "paid" },
        }),
      );
      break;

    case "market_created":
    case "bet_placed":
    case "market_resolved":
    case "liquidity_added":
    case "liquidity_removed":
      break;
  }

  // Push to bounded broadcast queue
  enqueueBroadcastEvent(event);

  // Publish to WebSocket channel for real-time updates if redis is configured
  try {
    const { redis } = await import("./db");
    if (redis && typeof (redis as any).publish === "function") {
      await (redis as any).publish(
        "indexer_events",
        JSON.stringify({
          type: event.eventType,
          contractId: event.contractId,
          ledgerSequence: event.ledgerSequence,
          value: event.value,
          batchId: event.batchId,
          timestamp: event.processedAt,
        }),
      );
    }
  } catch (err) {
    logger.debug({ err }, "Redis publish unavailable");
  }
}

// ─── Fault-Tolerant Batch Runner ─────────────────────────────────────────────

export async function runBatchWithRetry(
  server: rpc.Server,
  startLedger: number,
  batchId: number,
): Promise<BatchResult> {
  const config = BATCH_CONFIGS[batchId] || BATCH_CONFIGS[1];
  let lastResult: BatchResult | null = null;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    lastResult = await processEventBatch(server, startLedger, batchId);

    if (lastResult.errors.length === 0) {
      return lastResult;
    }

    if (attempt < config.maxRetries) {
      const backoffMs = Math.min(
        config.baseBackoffMs * Math.pow(2, attempt - 1),
        config.maxBackoffMs,
      );
      logger.warn(
        { batchId, attempt, errors: lastResult.errors.length, backoffMs },
        "Batch processing failed, retrying with backoff",
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  return lastResult!;
}
