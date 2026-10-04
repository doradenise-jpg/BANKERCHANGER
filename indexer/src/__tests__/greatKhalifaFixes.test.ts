import {
  enqueueBroadcastEvent,
  getEventQueue,
  getEventQueueDepth,
  clearEventQueue,
  DEFAULT_MAX_QUEUE_DEPTH,
} from '../eventPipeline';
import {
  indexerQueueOverflowTotal,
  indexerQueueDepth,
  indexerDbPoolSize,
  indexerDbPoolIdle,
  indexerLedgerLag,
} from '../metrics';
import {
  getPgPool,
  initDbPool,
  checkDbPoolHealth,
  updatePoolMetrics,
} from '../db';
import {
  detectLedgerAnomaly,
  scheduleMaintenanceWindow,
  getActiveMaintenanceWindows,
  getPendingBackfills,
  clearMaintenanceWindows,
} from '../ledgerContinuity';
import {
  updateLastLedger,
  updateLatestNetworkLedger,
  getLedgerLag,
  getHealthResponse,
} from '../health';

describe('greatKhalifa-code fixes: Issues #689, #690, #691, #695', () => {
  beforeEach(() => {
    clearEventQueue();
    clearMaintenanceWindows();
    indexerQueueOverflowTotal.reset();
    indexerQueueDepth.set(0);
    delete process.env.MAX_QUEUE_DEPTH;
  });

  describe('Issue #689: WebSocket Event Pipeline Bounded Queue', () => {
    it('caps queue depth at MAX_QUEUE_DEPTH and drops oldest events', () => {
      process.env.MAX_QUEUE_DEPTH = '5';

      for (let i = 1; i <= 7; i++) {
        enqueueBroadcastEvent({
          type: 'contract_event',
          contractId: `contract_${i}`,
          ledgerSequence: i,
          eventType: 'test_event',
          value: { id: i },
          processedAt: new Date().toISOString(),
          batchId: 1,
        });
      }

      // Max depth was 5, 2 events dropped
      expect(getEventQueueDepth()).toBe(5);
      expect(indexerQueueOverflowTotal.get()).toBe(2);
      expect(getEventQueue()[0].ledgerSequence).toBe(3); // oldest (1, 2) dropped
      expect(getEventQueue()[4].ledgerSequence).toBe(7);
    });

    it('defaults to 10,000 max queue depth if unspecified', () => {
      delete process.env.MAX_QUEUE_DEPTH;
      expect(DEFAULT_MAX_QUEUE_DEPTH).toBe(10000);
    });
  });

  describe('Issue #690: Indexer DB Module Connection Pooling', () => {
    it('initializes pool with min: 2 and max: 10 connections', () => {
      const p = getPgPool({ min: 2, max: 10 });
      expect(p).toBeDefined();
      const metrics = updatePoolMetrics();
      expect(metrics.totalCount).toBeGreaterThanOrEqual(2);
      expect(indexerDbPoolSize.get()).toBeGreaterThanOrEqual(2);
      expect(indexerDbPoolIdle.get()).toBeGreaterThanOrEqual(2);
    });

    it('verifies DB pool health on startup', async () => {
      await expect(checkDbPoolHealth()).resolves.toBe(true);
    });
  });

  describe('Issue #691: Ledger Continuity Planned Maintenance Windows', () => {
    it('suppresses gap alert and queues automatic backfill during maintenance window', () => {
      scheduleMaintenanceWindow({
        startLedger: 100,
        endLedger: 500,
        ttlSeconds: 3600,
        backfillRequired: true,
      });

      // Regular gap outside maintenance window returns 'gap'
      const normalGap = detectLedgerAnomaly(80, 50);
      expect(normalGap.type).toBe('gap');

      // Gap inside maintenance window returns 'maintenance_gap' and queues backfill
      const maintGap = detectLedgerAnomaly(400, 200);
      expect(maintGap.type).toBe('maintenance_gap');
      if (maintGap.type === 'maintenance_gap') {
        expect(maintGap.backfillPending).toBe(true);
      }

      const backfills = getPendingBackfills();
      expect(backfills.length).toBeGreaterThanOrEqual(1);
      expect(backfills[0].fromLedger).toBe(201);
      expect(backfills[0].toLedger).toBe(399);
    });
  });

  describe('Issue #695: Indexer Health Check Ledger Lag Reporting', () => {
    it('reports correct ledger lag, last_processed_ledger, and latest_network_ledger', () => {
      updateLastLedger(15000);
      updateLatestNetworkLedger(15450);

      expect(getLedgerLag()).toBe(450);
      expect(indexerLedgerLag.get()).toBe(450);

      const health = getHealthResponse();
      expect(health.ledger_lag).toBe(450);
      expect(health.last_processed_ledger).toBe(15000);
      expect(health.latest_network_ledger).toBe(15450);
      expect(health.status).toBe('healthy');
    });
  });
});
