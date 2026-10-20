import {
  validateEventSchema,
  indexer_schema_validation_failures_total,
  BetPlacedSchema,
  LiquidityAddedSchema,
  LiquidityRemovedSchema,
  InvoiceCreatedSchema,
  WinningsClaimedSchema,
  RefundClaimedSchema,
  parsePositiveI128,
  I128_MAX,
} from '../eventSchemas';
import { handleEvent } from '../eventPipeline';
import { logger } from '../logger';

jest.mock('../db', () => ({
  redis: { publish: jest.fn() },
  upsertInvoice: jest.fn(),
  upsertBetPlaced: jest.fn(),
  saveCursor: jest.fn(),
  getCursor: jest.fn(),
}));

const validBet = (amount: unknown) => ({
  market_id: 'market-999',
  amount,
  bettor: 'GB456...',
});

describe('Indexer Event Schema Validation (#64, #905)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete indexer_schema_validation_failures_total['bet_placed'];
    delete indexer_schema_validation_failures_total['BetPlaced'];
    delete indexer_schema_validation_failures_total['liquidity_added'];
    delete indexer_schema_validation_failures_total['winnings_claimed'];
  });

  describe('positive i128 enforcement', () => {
    it('accepts positive numbers, digit strings and bigints', () => {
      expect(BetPlacedSchema.safeParse(validBet(1)).success).toBe(true);
      expect(BetPlacedSchema.safeParse(validBet(250)).success).toBe(true);
      expect(BetPlacedSchema.safeParse(validBet('250')).success).toBe(true);
      expect(BetPlacedSchema.safeParse(validBet(1n)).success).toBe(true);
      expect(BetPlacedSchema.safeParse(validBet(10_000_000n)).success).toBe(true);
    });

    it('accepts the maximum Int128 boundary value in every representation', () => {
      expect(BetPlacedSchema.safeParse(validBet(I128_MAX)).success).toBe(true);
      expect(BetPlacedSchema.safeParse(validBet(I128_MAX.toString())).success).toBe(true);
      expect(parsePositiveI128(I128_MAX.toString())).toBe(I128_MAX);
    });

    it('rejects negative amounts in every representation', () => {
      expect(BetPlacedSchema.safeParse(validBet(-1)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet(-250)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet('-250')).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet(-1n)).success).toBe(false);
      expect(parsePositiveI128(-1n)).toBeNull();
    });

    it('rejects zero and non-positive values', () => {
      expect(BetPlacedSchema.safeParse(validBet(0)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet('0')).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet('00')).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet(0n)).success).toBe(false);
    });

    it('rejects invalid decimal / numeric string formats', () => {
      const invalid = [
        '1.5',
        '1.0',
        '0.1',
        '1e3',
        '-1',
        '+1',
        '0x10',
        '1,000',
        ' 1',
        '1 ',
        '',
        'NaN',
        'Infinity',
      ];
      for (const value of invalid) {
        expect(BetPlacedSchema.safeParse(validBet(value)).success).toBe(false);
      }
    });

    it('rejects non-integer, unsafe and non-finite numbers', () => {
      expect(BetPlacedSchema.safeParse(validBet(1.5)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet(NaN)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet(Infinity)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet(Number.MAX_SAFE_INTEGER + 1)).success).toBe(false);
    });

    it('rejects values outside the signed 128-bit range', () => {
      const overMax = I128_MAX + 1n;
      const underMin = -(I128_MAX + 1n);
      expect(BetPlacedSchema.safeParse(validBet(overMax)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet(overMax.toString())).success).toBe(false);
      expect(parsePositiveI128(underMin)).toBeNull();
    });

    it('rejects non-numeric payload types (booleans, null, objects)', () => {
      expect(BetPlacedSchema.safeParse(validBet(true as any)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet(null as any)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet({} as any)).success).toBe(false);
      expect(BetPlacedSchema.safeParse(validBet([] as any)).success).toBe(false);
    });
  });

  describe('bet amounts and payouts', () => {
    it('enforces positive amounts on liquidity and invoice schemas', () => {
      expect(
        LiquidityAddedSchema.safeParse({ market_id: 'm', amount: '-5' }).success,
      ).toBe(false);
      expect(
        LiquidityRemovedSchema.safeParse({ market_id: 'm', amount: '0' }).success,
      ).toBe(false);
      expect(InvoiceCreatedSchema.safeParse({ amount: '-1' }).success).toBe(false);
      expect(InvoiceCreatedSchema.safeParse({ amount: '100' }).success).toBe(true);
      expect(InvoiceCreatedSchema.safeParse({}).success).toBe(true);
    });

    it('validates payout amounts and rejects malicious negatives', () => {
      expect(
        WinningsClaimedSchema.safeParse({ amount_won: '1000', fee_deducted: '10' }).success,
      ).toBe(true);
      expect(
        WinningsClaimedSchema.safeParse({ amount_won: '-1000', fee_deducted: '10' }).success,
      ).toBe(false);
      expect(
        WinningsClaimedSchema.safeParse({ amount_won: '1000', fee_deducted: '-10' }).success,
      ).toBe(false);
      expect(RefundClaimedSchema.safeParse({ amount: '-1' }).success).toBe(false);
      expect(RefundClaimedSchema.safeParse({ amount: '1' }).success).toBe(true);
    });

    it('validates optional lp shares when present', () => {
      expect(
        LiquidityAddedSchema.safeParse({ market_id: 'm', amount: '10', shares: '-1' }).success,
      ).toBe(false);
      expect(
        LiquidityAddedSchema.safeParse({ market_id: 'm', amount: '10', shares: '1' }).success,
      ).toBe(true);
    });
  });

  describe('logging and metrics', () => {
    it('logs schema failures with detailed contract address context', () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger as any);

      const isValid = validateEventSchema(
        'bet_placed',
        { market_id: 'm', amount: '-100' },
        { contractId: 'CDANGEROUSCONTRACT', ledgerSequence: 42, batchId: 7 },
      );

      expect(isValid).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [logContext] = errorSpy.mock.calls[0];
      expect(logContext).toMatchObject({
        eventType: 'bet_placed',
        contractId: 'CDANGEROUSCONTRACT',
        ledgerSequence: 42,
        batchId: 7,
      });
      expect(indexer_schema_validation_failures_total['bet_placed']).toBe(1);

      errorSpy.mockRestore();
    });

    it('increments the failure metric for every rejected event', () => {
      validateEventSchema('winnings_claimed', { amount_won: '-1' });
      validateEventSchema('winnings_claimed', { amount_won: '0' });
      expect(indexer_schema_validation_failures_total['winnings_claimed']).toBe(2);
    });
  });

  describe('event pipeline integration', () => {
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

    it('skips a malicious BetPlaced event carrying a negative amount', async () => {
      const { redis } = await import('../db');
      const { upsertBetPlaced } = await import('../db');

      await handleEvent({
        type: 'contract_event',
        contractId: 'CEVIL',
        ledgerSequence: 101,
        eventType: 'bet_placed',
        value: { market_id: 'market-evil', amount: '-1000000000', bettor: 'GATTACKER' },
        processedAt: new Date().toISOString(),
        batchId: 1,
      });

      expect(redis.publish).not.toHaveBeenCalled();
      expect(upsertBetPlaced).not.toHaveBeenCalled();
    });

    it('validates the unwrapped bet record for tuple payloads', async () => {
      const { redis, upsertBetPlaced } = await import('../db');

      await handleEvent({
        type: 'contract_event',
        contractId: 'CTUPLE',
        ledgerSequence: 102,
        eventType: 'bet_placed',
        value: [
          { market_id: 'market-1', amount: '-5', bettor: 'GATTACKER' },
          { odds_a: 5000, odds_b: 5000, odds_draw: 0 },
        ],
        processedAt: new Date().toISOString(),
        batchId: 1,
      });

      expect(redis.publish).not.toHaveBeenCalled();
      expect(upsertBetPlaced).not.toHaveBeenCalled();

      await handleEvent({
        type: 'contract_event',
        contractId: 'CTUPLE',
        ledgerSequence: 103,
        eventType: 'bet_placed',
        value: [
          { market_id: 'market-1', amount: '5', bettor: 'GBETTOR' },
          { odds_a: 5000, odds_b: 5000, odds_draw: 0 },
        ],
        processedAt: new Date().toISOString(),
        batchId: 1,
      });

      expect(upsertBetPlaced).toHaveBeenCalledTimes(1);
      expect(redis.publish).toHaveBeenCalledTimes(1);
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
});
