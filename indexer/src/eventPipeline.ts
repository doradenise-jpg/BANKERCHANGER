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

interface ProcessedEvent {
  type: string;
  contractId: string;
  ledgerSequence: number;
  eventType: string;
  value: any;
  processedAt: string;
  batchId: number;
}

interface BatchResult {
  batchId: number;
  startLedger: number;
  endLedger: number;
  eventsProcessed: number;
  errors: string[];
  durationMs: number;
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
    // Fetch events for the batch range
    const endLedger = startLedger + config.batchSize - 1;
    const response = await server.getEvents({
      startLedger,
      endLedger,
      limit: 1000,
    });

    // Process events in order
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

    // Save cursor and update health
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

function parseEvent(event: any, ledgerSequence: number, batchId: number): ProcessedEvent | null {
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

// ─── Event Handlers ──────────────────────────────────────────────────────────

async function handleEvent(event: ProcessedEvent): Promise<void> {
  const { redis } = await import("./db");

  switch (event.eventType) {
    case "invoice_created":
      await upsertInvoice({
        contractId: event.contractId,
        ledgerSequence: event.ledgerSequence,
        data: event.value,
      });
      break;

    case "invoice_paid":
      await upsertInvoice({
        contractId: event.contractId,
        ledgerSequence: event.ledgerSequence,
        data: { ...event.value, status: "paid" },
      });
      break;

    case "market_created":
    case "bet_placed":
    case "market_resolved":
    case "liquidity_added":
    case "liquidity_removed":
      // These events are published for real-time updates
      break;

    default:
      logger.debug({ eventType: event.eventType, batchId: event.batchId }, "Unknown event type");
  }

  // Publish to WebSocket channel for real-time updates
  await redis.publish(
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
