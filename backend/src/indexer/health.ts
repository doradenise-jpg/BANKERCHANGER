import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Indexer monitoring primitives (issue #1052).
 *
 * Exposes Prometheus metrics and a lightweight health state that the
 * indexer updates as it processes ledgers and handles events.
 */

export const indexerRegistry = new Registry();

collectDefaultMetrics({ register: indexerRegistry });

export const ledgersProcessed = new Counter({
  name: 'indexer_ledgers_processed_total',
  help: 'Total number of ledgers processed by the indexer',
  registers: [indexerRegistry],
});

export const eventHandlersRun = new Counter({
  name: 'indexer_event_handlers_run_total',
  help: 'Total number of event handlers executed by the indexer',
  registers: [indexerRegistry],
});

export const errorsCount = new Counter({
  name: 'indexer_errors_total',
  help: 'Total number of errors encountered by the indexer',
  registers: [indexerRegistry],
});

export const consecutiveFailures = new Gauge({
  name: 'indexer_consecutive_failures',
  help: 'Current number of consecutive indexer failures',
  registers: [indexerRegistry],
});

export const indexerPaused = new Gauge({
  name: 'indexer_paused',
  help: 'Whether the indexer is paused (1) or running (0)',
  registers: [indexerRegistry],
});

/** Maximum consecutive failures before the indexer pauses and alerts. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Base backoff delay in milliseconds (1s, 2s, 4s, 8s, 16s). */
export const BASE_BACKOFF_MS = 1000;

/**
 * Compute the exponential backoff delay for a given failure attempt.
 * attempt is 1-based: 1 -> 1s, 2 -> 2s, 3 -> 4s, 4 -> 8s, 5 -> 16s.
 */
export function backoffDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return BASE_BACKOFF_MS * Math.pow(2, safeAttempt - 1);
}

export interface IndexerHealthState {
  healthy: boolean;
  paused: boolean;
  consecutiveFailures: number;
  lastError?: string;
  lastProcessedLedger?: number;
  updatedAt: string;
}

const state: IndexerHealthState = {
  healthy: true,
  paused: false,
  consecutiveFailures: 0,
  updatedAt: new Date().toISOString(),
};

function touch(): void {
  state.updatedAt = new Date().toISOString();
}

export function recordLedgerProcessed(ledger: number): void {
  ledgersProcessed.inc();
  state.lastProcessedLedger = ledger;
  state.consecutiveFailures = 0;
  state.healthy = true;
  consecutiveFailures.set(0);
  touch();
}

export function recordEventHandlerRun(): void {
  eventHandlersRun.inc();
}

export function recordFailure(error: unknown): number {
  errorsCount.inc();
  state.consecutiveFailures += 1;
  state.lastError = error instanceof Error ? error.message : String(error);
  consecutiveFailures.set(state.consecutiveFailures);
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    state.healthy = false;
  }
  touch();
  return state.consecutiveFailures;
}

export function resetFailures(): void {
  state.consecutiveFailures = 0;
  state.healthy = true;
  consecutiveFailures.set(0);
  touch();
}

export function markPaused(paused: boolean): void {
  state.paused = paused;
  indexerPaused.set(paused ? 1 : 0);
  touch();
}

export function getHealth(): IndexerHealthState {
  return { ...state };
}

export function isHealthy(): boolean {
  return state.healthy && !state.paused;
}

/**
 * Send an alert to the monitoring system. Falls back to a structured log
 * when no alert webhook is configured.
 */
export async function sendAlert(message: string, details?: Record<string, unknown>): Promise<void> {
  const webhook = process.env.MONITORING_ALERT_WEBHOOK;
  const payload = {
    source: 'stellar-indexer',
    message,
    details: details ?? {},
    timestamp: new Date().toISOString(),
  };

  if (!webhook) {
    // eslint-disable-next-line no-console
    console.error('[indexer][ALERT]', JSON.stringify(payload));
    return;
  }

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[indexer][ALERT] failed to deliver alert', err, JSON.stringify(payload));
  }
}
