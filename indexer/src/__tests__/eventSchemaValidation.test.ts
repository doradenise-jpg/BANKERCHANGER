import { validateEventSchema, indexer_schema_validation_failures_total } from '../eventSchemas';
import { handleEvent } from '../eventPipeline';

jest.mock('../db', () => ({
  redis: { publish: jest.fn() },
  upsertInvoice: jest.fn(),
  saveCursor: jest.fn(),
  getCursor: jest.fn(),
}));

describe('Indexer Event Schema Validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete indexer_schema_validation_failures_total['bet_placed'];
    delete indexer_schema_validation_failures_total['BetPlaced'];
  });

  it('rejects and skips a malformed BetPlaced event missing market_id', async () => {
    const malformedData = {
      amount: 100,
      bettor: 'GA123...',
      // missing market_id
    };

    const isValid = validateEventSchema('bet_placed', malformedData);
    expect(isValid).toBe(false);
    expect(indexer_schema_validation_failures_total['bet_placed']).toBe(1);

    const { redis } = await import('../db');
    await handleEvent({
      type: 'contract_event',
      contractId: 'C123',
      ledgerSequence: 100,
      eventType: 'bet_placed',
      value: malformedData,
      processedAt: new Date().toISOString(),
      batchId: 1,
    });

    // Should skip cleanly without publishing to Redis / DB
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('accepts valid BetPlaced event with required fields', () => {
    const validData = {
      market_id: 'market-999',
      amount: 250,
      bettor: 'GB456...',
    };

    const isValid = validateEventSchema('bet_placed', validData);
    expect(isValid).toBe(true);
    expect(indexer_schema_validation_failures_total['bet_placed']).toBeUndefined();
  });
});
