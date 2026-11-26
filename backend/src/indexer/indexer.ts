import { EventEmitter } from 'events';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Indexer monitoring and error recovery.
 *
 * - Emits Prometheus metrics: ledgers_processed, event_handlers_run, errors_count
 * - Tracks consecutive failures and applies exponential backoff on RPC errors
 *   (1s, 2s, 4s, 8s, 16s) before alerting and pausing.
 * - Pauses the indexer after 5 consecutive failures and sends an alert to the
 *   monitoring system.
 * - Performs a graceful shutdown on fatal error.
 * - Exposes a health check that returns 200 when healthy.
 */

export interface IndexerRpc {
  getLatestLedger(): Promise<number>;
  getEvents(params: { startLedger: number; limit?: number }): Promise<{ events: unknown[]; latestLedger: number }>;
}

export interface IndexerAlertSink {
  sendAlert(payload: { title: string; message: string; severity: 'warning' | 'critical'; details?: Record<string, unknown> }): Promise<void> | void;
}

export interface IndexerOptions {
  rpc: IndexerRpc;
  alertSink?: IndexerAlertSink;
  registry?: Registry;
  pollIntervalMs?: number;
  maxConsecutiveFailures?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 16000];
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_POLL_INTERVAL_MS = 5000;

export class Indexer extends EventEmitter {
  private readonly rpc: IndexerRpc;
  private readonly alertSink?: IndexerAlertSink;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly pollIntervalMs: number;
  private readonly maxConsecutiveFailures: number;

  private readonly registry: Registry;
  private readonly ledgersProcessed: Counter;
  private readonly eventHandlersRun: Counter;
  private readonly errorsCount: Counter;
  private readonly consecutiveFailuresGauge: Gauge;
  private readonly pausedGauge: Gauge;

  private consecutiveFailures = 0;
  private paused = false;
  private stopped = false;
  private running = false;
  private lastProcessedLedger = 0;
  private loopPromise: Promise<void> | null = null;

  constructor(options: IndexerOptions) {
    super();
    this.rpc = options.rpc;
    this.alertSink = options.alertSink;
    this.logger = options.logger ?? console;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

    this.registry = options.registry ?? new Registry();
    if (!options.registry) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.ledgersProcessed = new Counter({
      name: 'indexer_ledgers_processed_total',
      help: 'Total number of ledgers processed by the indexer',
      registers: [this.registry],
    });
    this.eventHandlersRun = new Counter({
      name: 'indexer_event_handlers_run_total',
      help: 'Total number of event handlers run by the indexer',
      registers: [this.registry],
    });
    this.errorsCount = new Counter({
      name: 'indexer_errors_count_total',
      help: 'Total number of errors encountered by the indexer',
      registers: [this.registry],
    });
    this.consecutiveFailuresGauge = new Gauge({
      name: 'indexer_consecutive_failures',
      help: 'Current number of consecutive indexer failures',
      registers: [this.registry],
    });
    this.pausedGauge = new Gauge({
      name: 'indexer_paused',
      help: 'Whether the indexer is paused (1) or running (0)',
      registers: [this.registry],
    });
  }

  /** Prometheus registry for exposing metrics via an HTTP endpoint. */
  getRegistry(): Registry {
    return this.registry;
  }

  /** Returns true when the indexer is running and not paused. */
  isHealthy(): boolean {
    return !this.paused && !this.stopped;
  }

  /**
   * Health check handler. Returns HTTP 200 when healthy, 503 otherwise.
   */
  async healthCheck(): Promise<{ status: number; body: { status: string; paused: boolean; consecutiveFailures: number } }> {
    const healthy = this.isHealthy();
    return {
      status: healthy ? 200 : 503,
      body: {
        status: healthy ? 'ok' : 'unhealthy',
        paused: this.paused,
        consecutiveFailures: this.consecutiveFailures,
      },
    };
  }

  /** Start the indexer loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  /** Gracefully stop the indexer loop. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      if (this.paused) {
        await this.sleep(this.pollIntervalMs);
        continue;
      }

      try {
        await this.processNext();
        this.onSuccess();
      } catch (error) {
        await this.onFailure(error);
      }

      if (!this.stopped && !this.paused) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private async processNext(): Promise<void> {
    const latestLedger = await this.rpc.getLatestLedger();
    const startLedger = this.lastProcessedLedger > 0 ? this.lastProcessedLedger + 1 : latestLedger;

    if (startLedger > latestLedger) {
      return;
    }

    const { events, latestLedger: reportedLatest } = await this.rpc.getEvents({ startLedger });

    for (const _event of events) {
      this.eventHandlersRun.inc();
    }

    this.ledgersProcessed.inc(Math.max(1, reportedLatest - startLedger + 1));
    this.lastProcessedLedger = reportedLatest;
  }

  private onSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.logger.info(`[indexer] recovered after ${this.consecutiveFailures} consecutive failure(s)`);
    }
    this.consecutiveFailures = 0;
    this.consecutiveFailuresGauge.set(0);
  }

  private async onFailure(error: unknown): Promise<void> {
    this.consecutiveFailures += 1;
    this.errorsCount.inc();
    this.consecutiveFailuresGauge.set(this.consecutiveFailures);

    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`[indexer] failure #${this.consecutiveFailures}: ${message}`);

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      await this.pauseAndAlert(message);
      return;
    }

    const backoffMs = BACKOFF_SCHEDULE_MS[Math.min(this.consecutiveFailures - 1, BACKOFF_SCHEDULE_MS.length - 1)];
    this.logger.warn(`[indexer] backing off for ${backoffMs}ms before retry`);
    await this.sleep(backoffMs);
  }

  private async pauseAndAlert(message: string): Promise<void> {
    this.paused = true;
    this.pausedGauge.set(1);
    this.logger.error(
      `[indexer] ALERT: pausing after ${this.consecutiveFailures} consecutive failures. Last error: ${message}`,
    );

    if (this.alertSink) {
      try {
        await this.alertSink.sendAlert({
          title: 'Indexer paused after consecutive failures',
          message: `Indexer paused after ${this.consecutiveFailures} consecutive failures: ${message}`,
          severity: 'critical',
          details: { consecutiveFailures: this.consecutiveFailures },
        });
      } catch (alertError) {
        this.logger.error(`[indexer] failed to send alert: ${alertError instanceof Error ? alertError.message : String(alertError)}`);
      }
    }

    this.emit('paused', { consecutiveFailures: this.consecutiveFailures, message });
  }

  /** Resume the indexer after a pause. */
  resume(): void {
    this.paused = false;
    this.consecutiveFailures = 0;
    this.consecutiveFailuresGauge.set(0);
    this.pausedGauge.set(0);
    this.logger.info('[indexer] resumed');
  }

  /**
   * Handle a fatal error: log, alert, and gracefully shut down.
   */
  async handleFatalError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.errorsCount.inc();
    this.logger.error(`[indexer] fatal error: ${message}`);

    if (this.alertSink) {
      try {
        await this.alertSink.sendAlert({
          title: 'Indexer fatal error',
          message: `Indexer shutting down due to fatal error: ${message}`,
          severity: 'critical',
        });
      } catch (alertError) {
        this.logger.error(`[indexer] failed to send fatal alert: ${alertError instanceof Error ? alertError.message : String(alertError)}`);
      }
    }

    this.emit('fatal', { message });
    await this.stop();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Allow the process to exit even if the timer is pending.
      if (typeof timer.unref === 'function') timer.unref();
    });
  }
}
