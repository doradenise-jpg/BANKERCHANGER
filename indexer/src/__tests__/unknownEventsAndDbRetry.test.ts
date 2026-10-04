import {
  handleEvent,
  indexer_unknown_event_types_total,
  isTransientDbError,
  deadLetterLog,
} from '../eventPipeline';
import * as db from '../db';

jest.mock('../db', () => ({
  redis: { publish: jest.fn() },
  upsertInvoice: jest.fn(),
  saveCursor: jest.fn(),
  getCursor: jest.fn(),
}));

describe('Unknown Event Types & Transient DB Retries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    deadLetterLog.length = 0;
    delete indexer_unknown_event_types_total['some_new_contract_event'];
  });

  it('skips unknown event types without throwing and increments counter (#694)', async () => {
    const unknownEvent = {
      type: 'contract_event',
      contractId: 'C_UNKNOWN',
      ledgerSequence: 500,
      eventType: 'some_new_contract_event',
      value: { foo: 'bar' },
      processedAt: new Date().toISOString(),
      batchId: 1,
    };

    await expect(handleEvent(unknownEvent)).resolves.not.toThrow();
    expect(indexer_unknown_event_types_total['some_new_contract_event']).toBe(1);
    expect(db.redis.publish).not.toHaveBeenCalled();
  });

  it('retries transient DB errors and succeeds on second attempt (#699)', async () => {
    let callCount = 0;
    (db.upsertInvoice as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Connection reset by peer (ECONNRESET)');
      }
      return true;
    });

    const invoiceEvent = {
      type: 'contract_event',
      contractId: 'C_INVOICE',
      ledgerSequence: 501,
      eventType: 'invoice_created',
      value: { amount: 100 },
      processedAt: new Date().toISOString(),
      batchId: 1,
    };

    await expect(handleEvent(invoiceEvent)).resolves.not.toThrow();
    expect(callCount).toBe(2);
    expect(deadLetterLog.length).toBe(0);
  });

  it('fails immediately without retry for non-transient DB constraint errors (#699)', async () => {
    let callCount = 0;
    (db.upsertInvoice as jest.Mock).mockImplementation(async () => {
      callCount++;
      throw new Error('UNIQUE constraint failed: invoices.id');
    });

    const invoiceEvent = {
      type: 'contract_event',
      contractId: 'C_INVOICE',
      ledgerSequence: 502,
      eventType: 'invoice_created',
      value: { amount: 200 },
      processedAt: new Date().toISOString(),
      batchId: 1,
    };

    await expect(handleEvent(invoiceEvent)).rejects.toThrow(/UNIQUE constraint failed/);
    expect(callCount).toBe(1); // No retry
  });
});
