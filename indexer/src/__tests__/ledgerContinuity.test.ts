import { describe, it, expect } from '@jest/globals';
import {
  detectLedgerAnomaly,
  computeResyncStartLedger,
  REORG_REWIND_LEDGERS,
} from '../ledgerContinuity';

describe('detectLedgerAnomaly', () => {
  it('returns none when there is no prior ledger to compare against', () => {
    expect(detectLedgerAnomaly(100, null)).toEqual({ type: 'none' });
  });

  it('returns none for the next sequential ledger', () => {
    expect(detectLedgerAnomaly(101, 100)).toEqual({ type: 'none' });
  });

  it('returns none when the ledger repeats (duplicate event delivery)', () => {
    expect(detectLedgerAnomaly(100, 100)).toEqual({ type: 'none' });
  });

  it('detects a re-org when the ledger sequence moves backward', () => {
    expect(detectLedgerAnomaly(95, 100)).toEqual({
      type: 'reorg',
      fromLedger: 100,
      toLedger: 95,
    });
  });

  it('detects a gap when ledgers are skipped', () => {
    expect(detectLedgerAnomaly(105, 100)).toEqual({
      type: 'gap',
      fromLedger: 101,
      toLedger: 104,
      missingCount: 4,
    });
  });

  it('does not flag a single skipped ledger as a gap', () => {
    // eventLedger=102 after lastProcessedLedger=100 means one ledger (101)
    // had no matching events, which is common and not a genuine gap.
    expect(detectLedgerAnomaly(102, 100)).toEqual({ type: 'none' });
  });
});

describe('computeResyncRange', () => {
  const { computeResyncRange } = require('../ledgerContinuity');

  it('correctly partitions a synthetic 500-ledger gap without omitting any ledgers', () => {
    const lastProcessed = 1000;
    const current = 1500; // 500 missing ledgers: 1001 to 1500
    const res = computeResyncRange(lastProcessed, current, 100);

    expect(res.startLedger).toBe(1001);
    expect(res.endLedger).toBe(1500);
    expect(res.totalGaps).toBe(500);
    expect(res.batches.length).toBe(5);

    // Verify all 500 ledgers are present in sequence
    let expectedStart = 1001;
    for (const batch of res.batches) {
      expect(batch.from).toBe(expectedStart);
      expectedStart = batch.to + 1;
    }
    expect(expectedStart).toBe(1501);
  });
});

