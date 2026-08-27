import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

// --- Shared Primitives ---

export const stellarPublicKeySchema = z
  .string({ required_error: 'Stellar public key is required' })
  .trim()
  .refine((val) => StrKey.isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar Ed25519 public key format',
  });

export const poolCategoryEnum = z.enum(['BOXING', 'MMA', 'KICKBOXING', 'ALL'], {
  errorMap: () => ({ message: 'category must be one of: BOXING, MMA, KICKBOXING, ALL' }),
});

export const poolSortByEnum = z.enum(['tvl', 'volume_24h', 'apr_bps', 'created_at'], {
  errorMap: () => ({ message: 'sort_by must be one of: tvl, volume_24h, apr_bps, created_at' }),
});

// --- Schemas ---

export const listPoolsGroup17QuerySchema = z.object({
  category: poolCategoryEnum.optional().default('ALL'),
  min_tvl_stroops: z
    .string()
    .regex(/^\d+$/, 'min_tvl_stroops must be a numeric string')
    .optional(),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'limit must be >= 1').max(100, 'limit cannot exceed 100').default(20),
  sort_by: poolSortByEnum.optional().default('tvl'),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const getPoolGroup17ParamsSchema = z.object({
  marketId: z.string().trim().min(1, 'marketId is required'),
});

export const addLiquidityGroup17BodySchema = z.object({
  market_id: z.string().trim().min(1, 'market_id is required'),
  amount_a_stroops: z
    .string({ required_error: 'amount_a_stroops is required' })
    .regex(/^\d+$/, 'amount_a_stroops must be a positive numeric string')
    .refine((val) => {
      try {
        return BigInt(val) > 0n;
      } catch {
        return false;
      }
    }, { message: 'amount_a_stroops must be greater than zero' }),
  amount_b_stroops: z
    .string({ required_error: 'amount_b_stroops is required' })
    .regex(/^\d+$/, 'amount_b_stroops must be a positive numeric string')
    .refine((val) => {
      try {
        return BigInt(val) > 0n;
      } catch {
        return false;
      }
    }, { message: 'amount_b_stroops must be greater than zero' }),
  min_lp_tokens: z
    .string({ required_error: 'min_lp_tokens is required' })
    .regex(/^\d+$/, 'min_lp_tokens must be a numeric string'),
  max_slippage_bps: z.coerce
    .number()
    .int()
    .min(0, 'max_slippage_bps must be >= 0')
    .max(5000, 'max_slippage_bps cannot exceed 5000 (50%)')
    .default(100),
  provider_address: stellarPublicKeySchema,
  deadline_seconds: z.coerce
    .number()
    .int()
    .min(60, 'deadline must be at least 60 seconds')
    .max(86400, 'deadline cannot exceed 86400 seconds (24h)')
    .optional()
    .default(3600),
});

export const removeLiquidityGroup17BodySchema = z.object({
  market_id: z.string().trim().min(1, 'market_id is required'),
  lp_tokens_to_burn: z
    .string({ required_error: 'lp_tokens_to_burn is required' })
    .regex(/^\d+$/, 'lp_tokens_to_burn must be a positive numeric string')
    .refine((val) => {
      try {
        return BigInt(val) > 0n;
      } catch {
        return false;
      }
    }, { message: 'lp_tokens_to_burn must be greater than zero' }),
  min_amount_a_stroops: z
    .string({ required_error: 'min_amount_a_stroops is required' })
    .regex(/^\d+$/, 'min_amount_a_stroops must be a numeric string'),
  min_amount_b_stroops: z
    .string({ required_error: 'min_amount_b_stroops is required' })
    .regex(/^\d+$/, 'min_amount_b_stroops must be a numeric string'),
  provider_address: stellarPublicKeySchema,
});

export const stakeLpGroup17BodySchema = z.object({
  pool_id: z.string().trim().min(1, 'pool_id is required'),
  lp_token_amount: z
    .string({ required_error: 'lp_token_amount is required' })
    .regex(/^\d+$/, 'lp_token_amount must be a numeric string')
    .refine((val) => {
      try {
        return BigInt(val) > 0n;
      } catch {
        return false;
      }
    }, { message: 'lp_token_amount must be greater than zero' }),
  lock_duration_days: z.coerce
    .number()
    .int()
    .min(0, 'lock_duration_days must be >= 0')
    .max(365, 'lock_duration_days cannot exceed 365 days')
    .default(0),
  staker_address: stellarPublicKeySchema,
});

export const claimRewardsGroup17BodySchema = z.object({
  pool_id: z.string().trim().min(1, 'pool_id is required'),
  recipient_address: stellarPublicKeySchema,
});

export const getUserPositionsGroup17ParamsSchema = z.object({
  address: stellarPublicKeySchema,
});

export type ListPoolsGroup17Query = z.infer<typeof listPoolsGroup17QuerySchema>;
export type GetPoolGroup17Params = z.infer<typeof getPoolGroup17ParamsSchema>;
export type AddLiquidityGroup17Body = z.infer<typeof addLiquidityGroup17BodySchema>;
export type RemoveLiquidityGroup17Body = z.infer<typeof removeLiquidityGroup17BodySchema>;
export type StakeLpGroup17Body = z.infer<typeof stakeLpGroup17BodySchema>;
export type ClaimRewardsGroup17Body = z.infer<typeof claimRewardsGroup17BodySchema>;
export type GetUserPositionsGroup17Params = z.infer<typeof getUserPositionsGroup17ParamsSchema>;
