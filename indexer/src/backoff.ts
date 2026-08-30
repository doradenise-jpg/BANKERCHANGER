/**
 * Exponential backoff for RPC polling retries, tunable via environment
 * variables so operators can adjust retry aggressiveness without a code
 * change. Kept separate from poller.ts so the math is unit testable without
 * mocking the RPC client or timers.
 */

export interface BackoffConfig {
  minMs: number;
  maxMs: number;
  multiplier: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  minMs: 1000, // 1 second
  maxMs: 5 * 60 * 1000, // 5 minutes
  multiplier: 2,
};

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads POLLER_MIN_BACKOFF_MS / POLLER_MAX_BACKOFF_MS / POLLER_BACKOFF_MULTIPLIER, falling back to defaults for missing or invalid values. */
export function loadBackoffConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackoffConfig {
  return {
    minMs: parsePositiveNumber(env.POLLER_MIN_BACKOFF_MS, DEFAULT_BACKOFF_CONFIG.minMs),
    maxMs: parsePositiveNumber(env.POLLER_MAX_BACKOFF_MS, DEFAULT_BACKOFF_CONFIG.maxMs),
    multiplier: parsePositiveNumber(env.POLLER_BACKOFF_MULTIPLIER, DEFAULT_BACKOFF_CONFIG.multiplier),
  };
}

/**
 * Computes the delay before the next retry, doubling (by default) on each
 * consecutive failure up to maxMs, with +/-50% jitter to avoid a thundering
 * herd of retries all firing at once.
 */
export function calculateBackoff(failureCount: number, config: BackoffConfig = DEFAULT_BACKOFF_CONFIG): number {
  const backoff = config.minMs * Math.pow(config.multiplier, failureCount - 1);
  const cappedBackoff = Math.min(backoff, config.maxMs);
  const jitter = cappedBackoff * (0.5 + Math.random() * 0.5);
  return Math.round(jitter);
}
