import { z } from 'zod';
import { logger } from './logger';

export const BetPlacedSchema = z.object({
  market_id: z.string().min(1, 'market_id is required'),
  amount: z.union([z.number(), z.string(), z.bigint()]),
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
  amount: z.union([z.number(), z.string(), z.bigint()]),
  provider: z.string().optional(),
});

export const LiquidityRemovedSchema = z.object({
  market_id: z.string().min(1, 'market_id is required'),
  amount: z.union([z.number(), z.string(), z.bigint()]),
  provider: z.string().optional(),
});

export const InvoiceCreatedSchema = z.object({
  contractId: z.string().optional(),
  amount: z.union([z.number(), z.string(), z.bigint()]).optional(),
});

export const InvoicePaidSchema = z.object({
  contractId: z.string().optional(),
  status: z.string().optional(),
});

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
};

// Metric counters
export const indexer_schema_validation_failures_total: Record<string, number> = {};

/**
 * Validates parsed event data against its schema.
 * Returns true if valid, false if invalid (and emits metrics/logs error).
 */
export function validateEventSchema(eventType: string, data: any): boolean {
  const schema = EVENT_SCHEMAS[eventType];
  if (!schema) {
    // If no schema defined for an event type, permit it by default
    return true;
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    indexer_schema_validation_failures_total[eventType] =
      (indexer_schema_validation_failures_total[eventType] || 0) + 1;

    logger.error(
      {
        eventType,
        metric: `indexer_schema_validation_failures_total{event_type="${eventType}"}`,
        count: indexer_schema_validation_failures_total[eventType],
        errors: result.error.errors,
        data,
      },
      `Schema validation failed for event type ${eventType}: event will be skipped`,
    );
    return false;
  }

  return true;
}
