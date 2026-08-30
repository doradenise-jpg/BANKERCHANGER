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

describe('computeResyncStartLedger', () => {
  it('rewinds by REORG_REWIND_LEDGERS', () => {
    expect(computeResyncStartLedger(1000)).toBe(1000 - REORG_REWIND_LEDGERS);
  });

  it('never returns a ledger below 1', () => {
    expect(computeResyncStartLedger(2)).toBe(1);
  });
});
