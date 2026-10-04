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
