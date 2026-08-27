import { z } from 'zod';

export const treasuryTransactionTypeEnum = z.enum([
  'deposit',
  'withdrawal',
  'fee_distribution',
  'fee_sweep',
  'reserve_allocation',
]);

export const marketTierEnum = z.enum([
  'standard',
  'high_roller',
  'title_bout',
  'championship',
]);

const stellarAddressOrContractRegex = /^[GC][A-Z2-7]{55}$/;

export const withdrawTreasuryGroup7BodySchema = z.object({
  destination_address: z
    .string()
    .trim()
    .regex(stellarAddressOrContractRegex, 'Destination address must be a valid Stellar account or contract ID'),
  amount_stroops: z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, 'Amount in stroops must be a positive integer string'),
  reason: z
    .string()
    .trim()
    .min(5, 'Reason must be at least 5 characters long')
    .max(500, 'Reason cannot exceed 500 characters'),
  idempotency_key: z
    .string()
    .trim()
    .min(8, 'Idempotency key must be at least 8 characters long')
    .max(64, 'Idempotency key cannot exceed 64 characters'),
});

export const distributeFeesGroup7BodySchema = z
  .object({
    period_id: z
      .string()
      .trim()
      .min(3, 'Period ID must be at least 3 characters long')
      .max(64, 'Period ID cannot exceed 64 characters'),
    lp_reward_bps: z
      .number()
      .int()
      .min(0, 'LP reward basis points must be non-negative')
      .max(10000, 'LP reward basis points cannot exceed 10000 bps'),
    reserve_bps: z
      .number()
      .int()
      .min(0, 'Reserve basis points must be non-negative')
      .max(10000, 'Reserve basis points cannot exceed 10000 bps'),
    staking_bps: z
      .number()
      .int()
      .min(0, 'Staking basis points must be non-negative')
      .max(10000, 'Staking basis points cannot exceed 10000 bps'),
  })
  .refine(
    (data) => data.lp_reward_bps + data.reserve_bps + data.staking_bps === 10000,
    {
      message: 'The sum of LP reward, reserve, and staking basis points must equal exactly 10000 bps (100%)',
      path: ['lp_reward_bps'],
    }
  );

export const updateFeeSplitsGroup7BodySchema = z
  .object({
    market_tier: marketTierEnum,
    platform_fee_bps: z
      .number()
      .int()
      .min(0, 'Platform fee basis points must be non-negative')
      .max(2000, 'Platform fee cannot exceed 2000 bps (20%)'),
    lp_cut_bps: z
      .number()
      .int()
      .min(0, 'LP cut basis points must be non-negative')
      .max(10000, 'LP cut basis points cannot exceed 10000 bps'),
    treasury_cut_bps: z
      .number()
      .int()
      .min(0, 'Treasury cut basis points must be non-negative')
      .max(10000, 'Treasury cut basis points cannot exceed 10000 bps'),
  })
  .refine((data) => data.lp_cut_bps + data.treasury_cut_bps === 10000, {
    message: 'LP cut and Treasury cut must sum to exactly 10000 basis points (100%)',
    path: ['lp_cut_bps'],
  });

export const listTreasuryTransactionsGroup7QuerySchema = z.object({
  type: treasuryTransactionTypeEnum.optional(),
  start_date: z.string().datetime({ message: 'Start date must be an ISO 8601 string' }).optional(),
  end_date: z.string().datetime({ message: 'End date must be an ISO 8601 string' }).optional(),
  page: z.coerce.number().int().min(1, 'Page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'Limit must be >= 1').max(100, 'Limit cannot exceed 100').default(20),
  sort_by: z.enum(['created_at', 'amount_stroops']).default('created_at'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export type WithdrawTreasuryGroup7Body = z.infer<typeof withdrawTreasuryGroup7BodySchema>;
export type DistributeFeesGroup7Body = z.infer<typeof distributeFeesGroup7BodySchema>;
export type UpdateFeeSplitsGroup7Body = z.infer<typeof updateFeeSplitsGroup7BodySchema>;
export type ListTreasuryTransactionsGroup7Query = z.infer<typeof listTreasuryTransactionsGroup7QuerySchema>;
