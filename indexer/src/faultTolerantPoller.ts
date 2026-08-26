import { rpc, scValToNative, Contract } from "@stellar/stellar-sdk";
import { getCursor, saveCursor, upsertInvoice } from "./db";
import { updateLastLedger } from "./health";
import { logger } from "./logger";
import dotenv from "dotenv";

dotenv.config();

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReorgDetection {
  detected: boolean;
  forkLedger: number;
  missingSequences: number[];
}

interface EventBatch {
  ledgerSequence: number;
  events: ContractEvent[];
  processedAt: string;
}

interface ContractEvent {
  type: string;
  contractId: string;
  ledgerSequence: number;
  eventType: string;
  value: any;
  xdr: string;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const REORG_DETECTION_DEPTH = parseInt(process.env.REORG_DETECTION_DEPTH || "10", 10);
const MAX_RETRY_ATTEMPTS = parseInt(process.env.MAX_RETRY_ATTEMPTS || "3", 10);
const BASE_BACKOFF_MS = parseInt(process.env.BASE_BACKOFF_MS || "1000", 10);
const MAX_BACKOFF_MS = parseInt(process.env.MAX_BACKOFF_MS || "300000", 10);
const BATCH_SIZE = parseInt(process.env.EVENT_BATCH_SIZE || "50", 10);

// ─── Re-org Detection ────────────────────────────────────────────────────────

export async function detectReorg(
  server: rpc.Server,
  currentLedger: number,
): Promise<ReorgDetection> {
  try {
    const ledgerHistory = await Promise.all(
      Array.from({ length: REORG_DETECTION_DEPTH }, (_, i) =>
        server.getLedger(currentLedger - i).catch(() => null),
      ),
    );

    const validLedgers = ledgerHistory.filter(Boolean);
    const missingSequences: number[] = [];

    for (let i = 0; i < validLedgers.length - 1; i++) {
      const current = validLedgers[i] as any;
      const previous = validLedgers[i + 1] as any;

      if (previous && current.sequence - previous.sequence > 1) {
        for (let seq = previous.sequence + 1; seq < current.sequence; seq++) {
          missingSequences.push(seq);
        }
      }
    }

    return {
      detected: missingSequences.length > 0,
      forkLedger: currentLedger,
      missingSequences,
    };
  } catch (error) {
    logger.error({ err: error, currentLedger }, "Failed to detect reorg");
    return {
      detected: false,
      forkLedger: currentLedger,
      missingSequences: [],
    };
  }
}

// ─── Missing Sequence Recovery ───────────────────────────────────────────────

export async function recoverMissingSequences(
  server: rpc.Server,
  missingSequences: number[],
): Promise<void> {
  for (const sequence of missingSequences) {
    logger.info({ sequence }, "Recovering missing ledger sequence");

    try {
      const ledger = await server.getLedger(sequence);
      const events = await fetchEventsForLedger(server, sequence);

      for (const event of events) {
        await processEvent(event);
      }

      await saveCursor(sequence);
      await updateLastLedger(sequence);

      logger.info({ sequence, eventCount: events.length }, "Recovered missing sequence");
    } catch (error) {
      logger.error({ err: error, sequence }, "Failed to recover missing sequence");
      throw error;
    }
  }
}

// ─── Event Fetching & Parsing ────────────────────────────────────────────────

async function fetchEventsForLedger(
  server: rpc.Server,
  ledgerSequence: number,
): Promise<ContractEvent[]> {
  const events: ContractEvent[] = [];

  try {
    const response = await server.getEvents({
      startLedger: ledgerSequence,
      endLedger: ledgerSequence,
      limit: 100,
    });

    for (const event of response.events) {
      const parsed = parseContractEvent(event, ledgerSequence);
      if (parsed) {
        events.push(parsed);
      }
    }
  } catch (error) {
    logger.error({ err: error, ledgerSequence }, "Failed to fetch events for ledger");
  }

  return events;
}

function parseContractEvent(event: any, ledgerSequence: number): ContractEvent | null {
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
      // If parsing fails, store raw XDR
      value = { raw: xdr };
    }

    return {
      type: "contract_event",
      contractId,
      ledgerSequence,
      eventType,
      value,
      xdr,
    };
  } catch (error) {
    logger.warn({ err: error }, "Failed to parse contract event");
    return null;
  }
}

// ─── Event Processing ────────────────────────────────────────────────────────

async function processEvent(event: ContractEvent): Promise<void> {
  switch (event.eventType) {
    case "invoice_created":
      await handleInvoiceCreated(event);
      break;
    case "invoice_paid":
      await handleInvoicePaid(event);
      break;
    case "market_created":
      await handleMarketCreated(event);
      break;
    case "bet_placed":
      await handleBetPlaced(event);
      break;
    case "market_resolved":
      await handleMarketResolved(event);
      break;
    default:
      logger.debug({ eventType: event.eventType }, "Unknown event type");
  }
}

async function handleInvoiceCreated(event: ContractEvent): Promise<void> {
  try {
    const invoiceData = event.value;
    await upsertInvoice({
      contractId: event.contractId,
      ledgerSequence: event.ledgerSequence,
      data: invoiceData,
    });

    await publishEvent("invoice_created", event);
  } catch (error) {
    logger.error({ err: error, event }, "Failed to handle invoice_created");
    throw error;
  }
}

async function handleInvoicePaid(event: ContractEvent): Promise<void> {
  try {
    const paymentData = event.value;
    await upsertInvoice({
      contractId: event.contractId,
      ledgerSequence: event.ledgerSequence,
      data: { ...paymentData, status: "paid" },
    });

    await publishEvent("invoice_paid", event);
  } catch (error) {
    logger.error({ err: error, event }, "Failed to handle invoice_paid");
    throw error;
  }
}

async function handleMarketCreated(event: ContractEvent): Promise<void> {
  await publishEvent("market_created", event);
}

async function handleBetPlaced(event: ContractEvent): Promise<void> {
  await publishEvent("bet_placed", event);
}

async function handleMarketResolved(event: ContractEvent): Promise<void> {
  await publishEvent("market_resolved", event);
}

// ─── WebSocket Publishing ────────────────────────────────────────────────────

async function publishEvent(type: string, event: ContractEvent): Promise<void> {
  try {
    const message = JSON.stringify({
      type,
      contractId: event.contractId,
      ledgerSequence: event.ledgerSequence,
      value: event.value,
      timestamp: new Date().toISOString(),
    });

    // Use Redis pub/sub for WebSocket distribution
    const { redis } = await import("./db");
    await redis.publish("indexer_events", message);
  } catch (error) {
    logger.error({ err: error, type }, "Failed to publish event");
  }
}

// ─── Exponential Backoff ─────────────────────────────────────────────────────

function calculateBackoff(attempt: number): number {
  const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

// ─── Fault-Tolerant Polling ──────────────────────────────────────────────────

export async function pollWithFaultTolerance(
  server: rpc.Server,
  currentLedger: number,
): Promise<number> {
  let attempt = 0;

  while (attempt < MAX_RETRY_ATTEMPTS) {
    try {
      // Check for re-orgs
      const reorg = await detectReorg(server, currentLedger);
      if (reorg.detected) {
        logger.warn(
          { forkLedger: reorg.forkLedger, missing: reorg.missingSequences },
          "Re-org detected, recovering missing sequences",
        );
        await recoverMissingSequences(server, reorg.missingSequences);
      }

      // Fetch and process events
      const events = await fetchEventsForLedger(server, currentLedger);

      for (const event of events) {
        await processEvent(event);
      }

      // Save cursor
      await saveCursor(currentLedger);
      await updateLastLedger(currentLedger);

      return currentLedger + 1;
    } catch (error: any) {
      attempt++;
      const isRpcError = error?.message?.includes("rpc") || error?.status === 429;

      if (isRpcError) {
        const backoffMs = calculateBackoff(attempt);
        logger.warn(
          { err: error, attempt, backoffMs },
          "RPC error, retrying with backoff",
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      } else {
        logger.error({ err: error, attempt }, "Non-RPC error during polling");
        throw error;
      }
    }
  }

  throw new Error(`Max retry attempts (${MAX_RETRY_ATTEMPTS}) exceeded`);
}
