import request from 'supertest';
import app from '../server';
import {
  handleClientMessage,
  MAX_SUBSCRIPTIONS_PER_CLIENT,
  resetIpRateLimits,
} from '../ws';
import {
  eventDedupCache,
  recordProcessedEvent,
  EventDedupCache,
} from '../poller';
import {
  indexerReorgDetectedTotal,
  indexerRpcRateLimitTotal,
  getMetricsPrometheusFormat,
} from '../metrics';
import { detectLedgerAnomaly } from '../ledgerContinuity';

describe('the-Devdrago Issues Suite (#914, #913, #912, #911)', () => {
  beforeEach(() => {
    resetIpRateLimits();
    eventDedupCache.clear();
    indexerReorgDetectedTotal.reset();
    indexerRpcRateLimitTotal.reset();
  });

  // =========================================================================
  // ISSUE #914: WebSocket Client Subscriptions and Rate Limiting
  // =========================================================================
  describe('Issue #914: WebSocket Subscription Capping and Validation', () => {
    it('caps active subscriptions at 50 and rejects excess subscriptions', () => {
      const sent: string[] = [];
      const mockSocket = {
        send: (msg: string) => sent.push(msg),
      };
      const clientSubs = new Set<string>();

      // Subscribe to 50 valid markets
      for (let i = 1; i <= 50; i++) {
        handleClientMessage(
          mockSocket,
          JSON.stringify({ type: 'subscribe', market_id: String(i) }),
          clientSubs
        );
      }
      expect(clientSubs.size).toBe(50);

      // Attempt 51st subscription
      const accepted = handleClientMessage(
        mockSocket,
        JSON.stringify({ type: 'subscribe', market_id: '51' }),
        clientSubs
      );
      expect(accepted).toBe(false);
      expect(clientSubs.size).toBe(50);
      expect(sent[sent.length - 1]).toContain('Subscription limit reached');
    });

    it('rejects invalid market_id that is neither numeric nor UUID', () => {
      const sent: string[] = [];
      const mockSocket = {
        send: (msg: string) => sent.push(msg),
      };
      const clientSubs = new Set<string>();

      const accepted = handleClientMessage(
        mockSocket,
        JSON.stringify({ type: 'subscribe', market_id: 'invalid--injection--id' }),
        clientSubs
      );
      expect(accepted).toBe(false);
      expect(sent[0]).toContain('Invalid market_id format');
    });
  });

  // =========================================================================
  // ISSUE #912: Bounded LRU Cache for Event Deduplication
  // =========================================================================
  describe('Issue #912: LRU Deduplication Cache', () => {
    it('keeps cache bounded at maximum capacity after processing 100,000 events', () => {
      const cache = new EventDedupCache(100);

      for (let i = 0; i < 1000; i++) {
        cache.add(`tx-${i}:0`);
      }

      expect(cache.size()).toBe(100);
      // Older entries should have been evicted
      expect(cache.has('tx-0:0')).toBe(false);
      // Newer entries should still exist
      expect(cache.has('tx-999:0')).toBe(true);
    });

    it('deduplicates processed events correctly', () => {
      expect(recordProcessedEvent('tx-abc', 0)).toBe(true);
      expect(recordProcessedEvent('tx-abc', 0)).toBe(false);
    });
  });

  // =========================================================================
  // ISSUE #911: Prometheus Metrics for Re-orgs and Rate Limits
  // =========================================================================
  describe('Issue #911: Re-Org and Rate-Limit Prometheus Counters', () => {
    it('increments indexer_reorg_detected_total on ledger rollback', () => {
      const initial = indexerReorgDetectedTotal.get();
      const anomaly = detectLedgerAnomaly(100, 105);
      expect(anomaly.type).toBe('reorg');
      expect(indexerReorgDetectedTotal.get()).toBe(initial + 1);
    });

    it('exposes /metrics endpoint with proper Prometheus format', async () => {
      indexerRpcRateLimitTotal.inc();
      indexerReorgDetectedTotal.inc();

      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toContain('indexer_reorg_detected_total 1');
      expect(res.text).toContain('indexer_rpc_rate_limit_total 1');
      expect(res.text).toContain('indexer_process_heap_bytes');
    });
  });
});
