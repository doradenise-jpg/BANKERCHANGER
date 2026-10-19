/**
 * Prometheus metrics registry and instruments for the indexer service.
 * Supports standard Prometheus metric exposition format.
 */

class MetricCounter {
  private value = 0;
  private labelsMap = new Map<string, number>();

  constructor(public readonly name: string, public readonly help: string, public readonly labelNames: string[] = []) {}

  inc(labels?: Record<string, string> | number, value: number = 1): void {
    if (typeof labels === 'number') {
      this.value += labels;
      return;
    }
    if (!labels || Object.keys(labels).length === 0) {
      this.value += value;
      return;
    }
    const key = JSON.stringify(labels);
    const curr = this.labelsMap.get(key) ?? 0;
    this.labelsMap.set(key, curr + value);
    this.value += value;
  }

  get(labels?: Record<string, string>): number {
    if (!labels || Object.keys(labels).length === 0) {
      return this.value;
    }
    return this.labelsMap.get(JSON.stringify(labels)) ?? 0;
  }

  reset(): void {
    this.value = 0;
    this.labelsMap.clear();
  }
}

class MetricGauge {
  private value = 0;
  private labelsMap = new Map<string, number>();

  constructor(public readonly name: string, public readonly help: string, public readonly labelNames: string[] = []) {}

  set(labelsOrValue: Record<string, string> | number, value?: number): void {
    if (typeof labelsOrValue === 'number') {
      this.value = labelsOrValue;
      return;
    }
    if (typeof value === 'number') {
      const key = JSON.stringify(labelsOrValue);
      this.labelsMap.set(key, value);
      this.value = value;
    }
  }

  get(labels?: Record<string, string>): number {
    if (!labels || Object.keys(labels).length === 0) {
      return this.value;
    }
    return this.labelsMap.get(JSON.stringify(labels)) ?? 0;
  }

  inc(labels?: Record<string, string> | number, value: number = 1): void {
    if (typeof labels === 'number') {
      this.value += labels;
      return;
    }
    const current = this.get(labels);
    this.set(labels || {}, current + value);
  }

  dec(labels?: Record<string, string> | number, value: number = 1): void {
    if (typeof labels === 'number') {
      this.value -= labels;
      return;
    }
    const current = this.get(labels);
    this.set(labels || {}, current - value);
  }

  reset(): void {
    this.value = 0;
    this.labelsMap.clear();
  }
}

class MetricHistogram {
  private count = 0;
  private sum = 0;
  private buckets: number[];

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
    buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  ) {
    this.buckets = buckets;
  }

  observe(val: number): void {
    this.count++;
    this.sum += val;
  }

  startTimer(): () => number {
    const start = Date.now();
    return () => {
      const duration = (Date.now() - start) / 1000;
      this.observe(duration);
      return duration;
    };
  }

  getCount(): number {
    return this.count;
  }

  getSum(): number {
    return this.sum;
  }
}

// ── Metrics Definitions ──────────────────────────────────────────────────────

/** Counter incremented when the in-memory WebSocket event broadcast queue overflows. */
export const indexerQueueOverflowTotal = new MetricCounter(
  'indexer_queue_overflow_total',
  'Total number of events dropped due to WebSocket event broadcast queue overflow'
);

/** Gauge tracking current depth of the in-memory WebSocket event broadcast queue. */
export const indexerQueueDepth = new MetricGauge(
  'indexer_queue_depth',
  'Current number of events buffered in the WebSocket broadcast queue'
);

/** Gauge tracking the indexer lag (latest network ledger - last processed ledger). */
export const indexerLedgerLag = new MetricGauge(
  'indexer_ledger_lag',
  'Number of ledgers the indexer is behind the latest network ledger'
);

/** Gauge tracking PostgreSQL connection pool size. */
export const indexerDbPoolSize = new MetricGauge(
  'indexer_db_pool_size',
  'Total number of connections in the indexer database connection pool'
);

/** Gauge tracking PostgreSQL idle connections in pool. */
export const indexerDbPoolIdle = new MetricGauge(
  'indexer_db_pool_idle',
  'Number of idle connections in the indexer database connection pool'
);

/** Counter tracking poll failures labeled by reason. */
export const indexerPollFailuresTotal = new MetricCounter(
  'indexer_poll_failures_total',
  'Total number of indexer poll failures by reason',
  ['reason']
);

/** Histogram tracking duration of poll cycles in seconds. */
export const indexerPollDurationSeconds = new MetricHistogram(
  'indexer_poll_duration_seconds',
  'Duration of indexer poll attempts in seconds'
);

/** Counter tracking gaps backfilled. */
export const indexerGapBackfillTotal = new MetricCounter(
  'indexer_gap_backfill_total',
  'Total number of missing ledgers backfilled'
);

/** Counter tracking re-org ledgers encountered (Issue #911). */
export const indexerReorgDetectedTotal = new MetricCounter(
  'indexer_reorg_detected_total',
  'Total number of ledger re-orgs detected by the indexer'
);

/** Counter tracking RPC rate limit (HTTP 429) events (Issue #911, #913). */
export const indexerRpcRateLimitTotal = new MetricCounter(
  'indexer_rpc_rate_limit_total',
  'Total number of RPC HTTP 429 rate limit events encountered'
);

/** Gauge tracking process resident memory bytes / heap memory (Issue #912). */
export const indexerProcessHeapBytes = new MetricGauge(
  'indexer_process_heap_bytes',
  'Process memory heap used in bytes'
);

/** Renders all Prometheus metrics in text format for /metrics endpoint. */
export function getMetricsPrometheusFormat(): string {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    indexerProcessHeapBytes.set(process.memoryUsage().heapUsed);
  }
  return [
    `# HELP indexer_queue_overflow_total ${indexerQueueOverflowTotal.help}`,
    `# TYPE indexer_queue_overflow_total counter`,
    `indexer_queue_overflow_total ${indexerQueueOverflowTotal.get()}`,
    `# HELP indexer_queue_depth ${indexerQueueDepth.help}`,
    `# TYPE indexer_queue_depth gauge`,
    `indexer_queue_depth ${indexerQueueDepth.get()}`,
    `# HELP indexer_ledger_lag ${indexerLedgerLag.help}`,
    `# TYPE indexer_ledger_lag gauge`,
    `indexer_ledger_lag ${indexerLedgerLag.get()}`,
    `# HELP indexer_reorg_detected_total ${indexerReorgDetectedTotal.help}`,
    `# TYPE indexer_reorg_detected_total counter`,
    `indexer_reorg_detected_total ${indexerReorgDetectedTotal.get()}`,
    `# HELP indexer_rpc_rate_limit_total ${indexerRpcRateLimitTotal.help}`,
    `# TYPE indexer_rpc_rate_limit_total counter`,
    `indexer_rpc_rate_limit_total ${indexerRpcRateLimitTotal.get()}`,
    `# HELP indexer_process_heap_bytes ${indexerProcessHeapBytes.help}`,
    `# TYPE indexer_process_heap_bytes gauge`,
    `indexer_process_heap_bytes ${indexerProcessHeapBytes.get()}`,
    `# HELP indexer_poll_failures_total ${indexerPollFailuresTotal.help}`,
    `# TYPE indexer_poll_failures_total counter`,
    `indexer_poll_failures_total ${indexerPollFailuresTotal.get()}`,
    `# HELP indexer_gap_backfill_total ${indexerGapBackfillTotal.help}`,
    `# TYPE indexer_gap_backfill_total counter`,
    `indexer_gap_backfill_total ${indexerGapBackfillTotal.get()}`,
  ].join('\n') + '\n';
}
