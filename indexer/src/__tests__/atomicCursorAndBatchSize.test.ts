import { resolveBatchSize, computeEffectiveBatchSize, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE } from '../poller';
import { saveEventsAndCursorAtomic, getCursor, getDatabase } from '../db';

describe('Batch Size & Atomic Cursor Persistence (#693, #697)', () => {
  describe('Batch Size Configuration (#693)', () => {
    it('uses default 50 when INDEXER_BATCH_SIZE is unset or invalid', () => {
      expect(resolveBatchSize(undefined)).toBe(DEFAULT_BATCH_SIZE);
      expect(resolveBatchSize('invalid')).toBe(DEFAULT_BATCH_SIZE);
      expect(resolveBatchSize('-10')).toBe(DEFAULT_BATCH_SIZE);
    });

    it('parses valid INDEXER_BATCH_SIZE and caps at MAX_BATCH_SIZE (500)', () => {
      expect(resolveBatchSize('200')).toBe(200);
      expect(resolveBatchSize('1000')).toBe(MAX_BATCH_SIZE);
    });

    it('automatically increases batch size to 500 when lag > 1000 ledgers', () => {
      expect(computeEffectiveBatchSize(50)).toBe(DEFAULT_BATCH_SIZE);
      expect(computeEffectiveBatchSize(1500)).toBe(MAX_BATCH_SIZE);
    });
  });

  describe('Atomic Cursor Persistence (#697)', () => {
    it('persists event inserts and cursor atomically in one transaction', async () => {
      const db = getDatabase();

      const testEvents = [
        {
          id: 'INV_ATOMIC_1',
          freelancer: 'FL_1',
          payer: 'PAY_1',
          amount: 500,
          due_date: '2026-10-01',
          status: 'pending',
        },
      ];

      saveEventsAndCursorAtomic(testEvents, {
        pagingToken: 'token_ledger_500',
        lastLedger: 500,
      });

      const cursor = await getCursor();
      expect(cursor).toBe('token_ledger_500');

      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get('INV_ATOMIC_1') as any;
      expect(inv).toBeDefined();
      expect(inv.amount).toBe(500);
    });
  });
});
