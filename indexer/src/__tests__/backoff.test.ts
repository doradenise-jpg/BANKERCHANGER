import { describe, it, expect } from '@jest/globals';
import { calculateBackoff, computeBackoff, loadBackoffConfigFromEnv, DEFAULT_BACKOFF_CONFIG } from '../backoff';

describe('calculateBackoff', () => {
  const config = { minMs: 1000, maxMs: 5 * 60 * 1000, multiplier: 2 };

  it('stays within [1x, 2x] of minMs on the first failure', () => {
    const delay = calculateBackoff(1, config);
    expect(delay).toBeGreaterThanOrEqual(config.minMs);
    expect(delay).toBeLessThanOrEqual(config.minMs * 2);
  });

  it('caps the delay at maxMs regardless of failure count', () => {
    const delay = calculateBackoff(100, config);
    expect(delay).toBeLessThanOrEqual(config.maxMs);
  });

  it('guarantees that 100 random calls to computeBackoff(attempt=20) all return <= max_delay', () => {
    for (let i = 0; i < 100; i++) {
      const delay = computeBackoff(20, config);
      expect(delay).toBeLessThanOrEqual(config.maxMs);
      expect(delay).toBeGreaterThan(0);
    }
  });
});

describe('loadBackoffConfigFromEnv', () => {
  it('falls back to defaults when no env vars are set', () => {
    expect(loadBackoffConfigFromEnv({})).toEqual(DEFAULT_BACKOFF_CONFIG);
  });

  it('reads valid overrides from the environment', () => {
    const config = loadBackoffConfigFromEnv({
      POLLER_MIN_BACKOFF_MS: '500',
      POLLER_MAX_BACKOFF_MS: '60000',
      POLLER_BACKOFF_MULTIPLIER: '3',
    });
    expect(config).toEqual({ minMs: 500, maxMs: 60000, multiplier: 3 });
  });

  it('ignores invalid or non-positive overrides and falls back to defaults', () => {
    const config = loadBackoffConfigFromEnv({
      POLLER_MIN_BACKOFF_MS: 'not-a-number',
      POLLER_MAX_BACKOFF_MS: '-100',
      POLLER_BACKOFF_MULTIPLIER: '0',
    });
    expect(config).toEqual(DEFAULT_BACKOFF_CONFIG);
  });
});
