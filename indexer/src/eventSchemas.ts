import { z } from 'zod';
import { logger } from './logger';

// ─── Int128 numeric validation ───────────────────────────────────────────────
//
// Stellar contracts encode monetary values as signed 128-bit integers (i128)
// and the SDK frequently surfaces them as `bigint` or decimal strings. A
// malicious or misbehaving contract can emit negative, zero, decimal or
// out-of-range values which, if persisted, corrupt pool accounting. The
// helpers below reject anything that is not a strict, positive, in-range i128.

/** Inclusive lower bound of a signed 128-bit integer. */
export const I128_MIN = -(1n << 127n);
/** Inclusive upper bound of a signed 128-bit integer. */
export const I128_MAX = (1n << 127n) - 1n;

/** Strict decimal integer: digits only (no sign, decimal point, exponent or padding). */
const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/;

/**
 * Parses a candidate amount into a bigint, applying strict i128 validation.
 *
 * Accepts:
 *  - `bigint` values
 *  - safe integer `number` values (unsafe/float numbers are rejected to avoid
 *    silent precision loss)
 *  - canonical decimal `string` values (digits only)
 *
 * Rejects negative values, zero, decimals, exponents, hex literals, whitespace,
 * empty strings, NaN/Infinity and values outside the signed 128-bit range.
 *
 * @param allowZero when `true`, zero is accepted (used for fee fields that may
 *                  legitimately be zero); otherwise the value must be > 0.
 */
export function parseI128(value: unknown, allowZero = false): bigint | null {
  let parsed: bigint;

  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    // Reject numbers that cannot be represented exactly as integers.
    if (!Number.isSafeInteger(value)) return null;
    parsed = BigInt(value);
  } else if (typeof value === 'string') {
    if (!DECIMAL_INTEGER_PATTERN.test(value)) return null;
    parsed = BigInt(value);
  } else {
    return null;
  }

  if (allowZero ? parsed < 0n : parsed <= 0n) return null;
  if (parsed < I128_MIN || parsed > I128_MAX) return null;

  return parsed;
}

/** Returns the parsed bigint when `value` is a strict positive i128, else null. */
export function parsePositiveI128(value: unknown): bigint | null {
  return parseI128(value, false);
}

/** Returns the parsed bigint when `value` is a non-negative i128, else null. */
export function parseNonNegativeI128(value: unknown): bigint | null {
  return parseI128(value, true);
}

const i128Input = z.union([z.number(), z.string(), z.bigint()]);

/** Zod schema enforcing a strictly positive, non-zero, in-range i128. */
export const positiveI128Schema = i128Input.refine(
  (value) => parsePositiveI128(value) !== null,
  { message: 'value must be a positive non-zero integer that fits within an Int128' },
);

/** Zod schema enforcing a non-negative, in-range i128 (zero allowed). */
export const nonNegativeI128Schema = i128Input.refine(
  (value) => parseNonNegativeI128(value) !== null,
  { message: 'value must be a non-negative integer that fits within an Int128' },
);

// ─── Event Schemas ───────────────────────────────────────────────────────────

export const BetPlacedSchema = z.object({
  market_id: z.string().min(1, 'market_id is required'),
  amount: positiveI128Schema,
  bettor: z.string().min(1).optional(),
  side: z.string().min(1).optional(),
});

export const MarketCreatedSchema = z.object({
  market_id: z.string().min(1, 'market_id is required'),
  title: z.string().optional(),
});

export const MarketResolvedSchema = z.object({
  market_id: z.string().min(1, 'market_id is required'),
  outcome: z.string().optional(),
});

export const LiquidityAddedSchema = z.object({
  market_id: z.string().min(1, 'market_id is required'),
  amount: positiveI128Schema,
  provider: z.string().optional(),
  shares: positiveI128Schema.optional(),
  lp_shares: positiveI128Schema.optional(),
});

export const LiquidityRemovedSchema = z.object({
  market_id: z.string().min(1, 'market_id is required'),
  amount: positiveI128Schema,
  provider: z.string().optional(),
  shares: positiveI128Schema.optional(),
  lp_shares: positiveI128Schema.optional(),
  fees_claimed: nonNegativeI128Schema.optional(),
});

export const InvoiceCreatedSchema = z.object({
  contractId: z.string().optional(),
  amount: positiveI128Schema.optional(),
});

export const InvoicePaidSchema = z.object({
  contractId: z.string().optional(),
  status: z.string().optional(),
});

/** Payout event: gross winnings and the fee deducted before transfer. */
export const WinningsClaimedSchema = z.object({
  bettor: z.string().optional(),
  market_id: z.string().optional(),
  amount_won: positiveI128Schema,
  fee_deducted: nonNegativeI128Schema.optional(),
});

/** Payout event: stake refunded after cancellation/expiry. */
export const RefundClaimedSchema = z.object({
  bettor: z.string().optional(),
  market_id: z.string().optional(),
  amount: positiveI128Schema,
});

export const MarketExpiredRefundSchema = RefundClaimedSchema;

export const EVENT_SCHEMAS: Record<string, z.ZodSchema> = {
  bet_placed: BetPlacedSchema,
  BetPlaced: BetPlacedSchema,
  market_created: MarketCreatedSchema,
  MarketCreated: MarketCreatedSchema,
  market_resolved: MarketResolvedSchema,
  MarketResolved: MarketResolvedSchema,
  liquidity_added: LiquidityAddedSchema,
  LiquidityAdded: LiquidityAddedSchema,
  liquidity_removed: LiquidityRemovedSchema,
  LiquidityRemoved: LiquidityRemovedSchema,
  invoice_created: InvoiceCreatedSchema,
  invoice_paid: InvoicePaidSchema,
  winnings_claimed: WinningsClaimedSchema,
  WinningsClaimed: WinningsClaimedSchema,
  refund_claimed: RefundClaimedSchema,
  RefundClaimed: RefundClaimedSchema,
  market_expired_refund: MarketExpiredRefundSchema,
  MarketExpiredRefund: MarketExpiredRefundSchema,
};

// Metric counters
export const indexer_schema_validation_failures_total: Record<string, number> = {};

export interface EventValidationContext {
  /** Contract address (C...) that emitted the event, included in failure logs. */
  contractId?: string;
  /** Alias for {@link contractId}. */
  contractAddress?: string;
  ledgerSequence?: number;
  batchId?: number;
}

/**
 * Validates parsed event data against its schema.
 * Returns true if valid, false if invalid (and emits metrics/logs error).
 *
 * When invalid, the failure is logged together with the originating contract
 * address and ledger for fast incident triage.
 */
export function validateEventSchema(
  eventType: string,
  data: any,
  context: EventValidationContext = {},
): boolean {
  const schema = EVENT_SCHEMAS[eventType];
  if (!schema) {
    // If no schema defined for an event type, permit it by default
    return true;
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    indexer_schema_validation_failures_total[eventType] =
      (indexer_schema_validation_failures_total[eventType] || 0) + 1;

    const contractAddress = context.contractId ?? context.contractAddress;

    logger.error(
      {
        eventType,
        contractId: contractAddress,
        contractAddress,
        ledgerSequence: context.ledgerSequence,
        batchId: context.batchId,
        metric: `indexer_schema_validation_failures_total{event_type="${eventType}"}`,
        count: indexer_schema_validation_failures_total[eventType],
        errors: result.error.errors,
        data,
      },
      `Schema validation failed for event type ${eventType} from contract ${contractAddress ?? 'unknown'}: event will be skipped`,
    );
    return false;
  }

  return true;
}
