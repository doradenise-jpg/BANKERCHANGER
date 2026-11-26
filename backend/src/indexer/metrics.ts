import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics for the Stellar indexer.
 *
 * Exposes:
 *  - ledgers_processed   (counter)  ledgers successfully processed
 *  - event_handlers_run  (counter)  event handlers executed
 *  - errors_count        (counter)  errors encountered while indexing
 *  - indexer_healthy     (gauge)    1 when healthy, 0 when paused/failed
 *  - consecutive_failures(gauge)    current consecutive failure streak
 */
export const indexerRegistry = new Registry();

collectDefaultMetrics({ register: indexerRegistry });

export const ledgersProcessed = new Counter({
  name: 'ledgers_processed',
  help: 'Total number of ledgers processed by the indexer',
  registers: [indexerRegistry],
});

export const eventHandlersRun = new Counter({
  name: 'event_handlers_run',
  help: 'Total number of event handlers run by the indexer',
  registers: [indexerRegistry],
});

export const errorsCount = new Counter({
  name: 'errors_count',
  help: 'Total number of errors encountered by the indexer',
  registers: [indexerRegistry],
});

export const indexerHealthy = new Gauge({
  name: 'indexer_healthy',
  help: 'Whether the indexer is healthy (1) or paused/failed (0)',
  registers: [indexerRegistry],
});

export const consecutiveFailures = new Gauge({
  name: 'indexer_consecutive_failures',
  help: 'Current number of consecutive indexer failures',
  registers: [indexerRegistry],
});

/**
 * Render all indexer metrics in Prometheus text exposition format.
 */
export async function renderMetrics(): Promise<string> {
  return indexerRegistry.metrics();
}

export function metricsContentType(): string {
  return indexerRegistry.contentType;
}
