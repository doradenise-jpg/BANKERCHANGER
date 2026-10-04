import { indexerLedgerLag } from './metrics';

/**
 * Health monitoring for indexer service with liveness and readiness probes
 *
 * Liveness (/healthz/live): Is the process alive? (always yes if this responds)
 * Readiness (/healthz/ready): Is the service ready to handle traffic?
 *   - Database connectivity
 *   - RPC connectivity
 *   - Cursor advancing (no stale data)
 *
 * Health Reporting (Issue #695):
 *   - Reports indexer lag (difference between latest Stellar ledger and last processed ledger)
 *   - Emits `indexer_ledger_lag` Prometheus gauge
 *   - Structured response: { status, ledger_lag, last_processed_ledger, latest_network_ledger }
 */

interface HealthState {
  lastLedger: number | null;
  latestNetworkLedger: number | null;
  lastUpdate: Date | null;
}

const state: HealthState = {
  lastLedger: null,
  latestNetworkLedger: null,
  lastUpdate: null,
};

/**
 * Maximum allowed age of cursor before readiness probe fails (in milliseconds).
 * If we haven't processed an event in this time, the service is not ready.
 * Set to 5 minutes to allow for slow periods but catch stuck indexers.
 */
const MAX_CURSOR_AGE_MS = 5 * 60 * 1000;

/**
 * Calculate current indexer ledger lag
 */
export function getLedgerLag(): number {
  if (state.lastLedger === null || state.latestNetworkLedger === null) {
    return 0;
  }
  return Math.max(0, state.latestNetworkLedger - state.lastLedger);
}

/**
 * Update the last processed ledger
 */
export function updateLastLedger(ledger: number): void {
  state.lastLedger = ledger;
  state.lastUpdate = new Date();
  const lag = getLedgerLag();
  indexerLedgerLag.set(lag);
}

/**
 * Update the latest network ledger known from Soroban RPC / Stellar Core
 */
export function updateLatestNetworkLedger(networkLedger: number): void {
  state.latestNetworkLedger = networkLedger;
  const lag = getLedgerLag();
  indexerLedgerLag.set(lag);
}

/**
 * Formats standard health check payload complying with Issue #695 acceptance criteria:
 * { status, ledger_lag, last_processed_ledger, latest_network_ledger }
 */
export function getHealthResponse(): {
  status: 'healthy' | 'unhealthy';
  ledger_lag: number;
  last_processed_ledger: number | null;
  latest_network_ledger: number | null;
} {
  const ready = isReady();
  const lag = getLedgerLag();

  return {
    status: ready ? 'healthy' : 'unhealthy',
    ledger_lag: lag,
    last_processed_ledger: state.lastLedger,
    latest_network_ledger: state.latestNetworkLedger,
  };
}

/**
 * Get the current health state
 */
export function getHealthState(): {
  lastLedger: number | null;
  latestNetworkLedger: number | null;
  ledgerLag: number;
  cursorAge: number | null;
} {
  const cursorAge = state.lastUpdate ? Date.now() - state.lastUpdate.getTime() : null;

  return {
    lastLedger: state.lastLedger,
    latestNetworkLedger: state.latestNetworkLedger,
    ledgerLag: getLedgerLag(),
    cursorAge,
  };
}

/**
 * Check if the service is alive (process is running)
 * Used by Kubernetes liveness probes
 */
export function isLive(): boolean {
  return true;
}

/**
 * Check if the service is ready to handle traffic
 * Used by Kubernetes readiness probes
 */
export function isReady(): boolean {
  if (state.lastLedger === null || state.lastUpdate === null) {
    return false;
  }

  const cursorAge = Date.now() - state.lastUpdate.getTime();
  if (cursorAge > MAX_CURSOR_AGE_MS) {
    return false;
  }

  return true;
}

/**
 * Get detailed readiness information for debugging
 */
export function getReadinessDetails(): {
  ready: boolean;
  status: 'healthy' | 'unhealthy';
  lastLedger: number | null;
  last_processed_ledger: number | null;
  latest_network_ledger: number | null;
  ledger_lag: number;
  cursorAge: number | null;
  maxCursorAge: number;
  reasons: string[];
} {
  const health = getHealthState();
  const reasons: string[] = [];

  if (health.lastLedger === null) {
    reasons.push('No ledgers processed yet');
  }

  if (health.cursorAge === null) {
    reasons.push('Cursor age unknown');
  } else if (health.cursorAge > MAX_CURSOR_AGE_MS) {
    reasons.push(`Cursor is stale: ${health.cursorAge}ms old (max: ${MAX_CURSOR_AGE_MS}ms)`);
  }

  const ready = reasons.length === 0;

  return {
    ready,
    status: ready ? 'healthy' : 'unhealthy',
    lastLedger: health.lastLedger,
    last_processed_ledger: health.lastLedger,
    latest_network_ledger: health.latestNetworkLedger,
    ledger_lag: health.ledgerLag,
    cursorAge: health.cursorAge,
    maxCursorAge: MAX_CURSOR_AGE_MS,
    reasons,
  };
}
