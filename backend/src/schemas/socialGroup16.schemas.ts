import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';
import { stripHtml, sanitizedString } from './validation.schemas';

// --- Shared Primitives ---

export const stellarPublicKeySchema = z
  .string({ required_error: 'Stellar public key is required' })
  .trim()
  .refine((val) => StrKey.isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar Ed25519 public key format',
  });

export const syndicateStatusEnum = z.enum(['recruiting', 'active', 'closed', 'all'], {
  errorMap: () => ({ message: 'status must be one of: recruiting, active, closed, all' }),
});

export const syndicateCategoryEnum = z.enum(['BOXING', 'MMA', 'KICKBOXING', 'ALL'], {
  errorMap: () => ({ message: 'category must be one of: BOXING, MMA, KICKBOXING, ALL' }),
});

export const syndicateSortByEnum = z.enum(['total_staked', 'roi_bps', 'member_count', 'created_at'], {
  errorMap: () => ({ message: 'sort_by must be one of: total_staked, roi_bps, member_count, created_at' }),
});

export const copyTradeStatusEnum = z.enum(['active', 'paused', 'all'], {
  errorMap: () => ({ message: 'status must be one of: active, paused, all' }),
});

// --- Schemas ---

export const listSyndicatesGroup16QuerySchema = z.object({
  status: syndicateStatusEnum.optional().default('all'),
  category: syndicateCategoryEnum.optional().default('ALL'),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'limit must be >= 1').max(100, 'limit cannot exceed 100').default(20),
  sort_by: syndicateSortByEnum.optional().default('total_staked'),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const getSyndicateGroup16ParamsSchema = z.object({
  syndicateId: z.string().trim().min(1, 'syndicateId is required'),
});

export const createSyndicateGroup16BodySchema = z.object({
  name: sanitizedString(3, 50),
  description: sanitizedString(10, 500),
  leader_address: stellarPublicKeySchema,
  min_stake_stroops: z
    .string({ required_error: 'min_stake_stroops is required' })
    .regex(/^\d+$/, 'min_stake_stroops must be a positive numeric stroop string')
    .refine((val) => {
      try {
        return BigInt(val) > 0n;
      } catch {
        return false;
      }
    }, { message: 'min_stake_stroops must be greater than zero' }),
  max_members: z.coerce.number().int().min(2, 'max_members must be at least 2').max(500, 'max_members cannot exceed 500').default(50),
  manager_fee_bps: z.coerce
    .number()
    .int()
    .min(0, 'manager_fee_bps must be >= 0')
    .max(3000, 'manager_fee_bps cannot exceed 3000 (30%)')
    .default(500),
  is_private: z.boolean().optional().default(false),
  allowed_categories: z.array(syndicateCategoryEnum).optional().default(['ALL']),
});

export const depositSyndicateGroup16BodySchema = z.object({
  amount_stroops: z
    .string({ required_error: 'amount_stroops is required' })
    .regex(/^\d+$/, 'amount_stroops must be a numeric stroop string')
    .refine((val) => {
      try {
        return BigInt(val) > 0n;
      } catch {
        return false;
      }
    }, { message: 'amount_stroops must be greater than zero' }),
  sender_address: stellarPublicKeySchema,
  idempotency_key: z
    .string({ required_error: 'idempotency_key is required' })
    .trim()
    .min(8, 'idempotency_key must be at least 8 characters')
    .max(64, 'idempotency_key cannot exceed 64 characters'),
});

export const followCopyTradeGroup16BodySchema = z.object({
  trader_address: stellarPublicKeySchema,
  copy_ratio_bps: z.coerce
    .number()
    .int()
    .min(100, 'copy_ratio_bps must be at least 100 (1%)')
    .max(10000, 'copy_ratio_bps cannot exceed 10000 (100%)'),
  max_stake_per_bet_stroops: z
    .string({ required_error: 'max_stake_per_bet_stroops is required' })
    .regex(/^\d+$/, 'max_stake_per_bet_stroops must be a numeric stroop string')
    .refine((val) => {
      try {
        return BigInt(val) > 0n;
      } catch {
        return false;
      }
    }, { message: 'max_stake_per_bet_stroops must be greater than zero' }),
  daily_stop_loss_stroops: z
    .string()
    .regex(/^\d+$/, 'daily_stop_loss_stroops must be a numeric stroop string')
    .optional(),
  max_slippage_bps: z.coerce
    .number()
    .int()
    .min(0, 'max_slippage_bps must be >= 0')
    .max(5000, 'max_slippage_bps cannot exceed 5000 (50%)')
    .optional()
    .default(500),
});

export const unfollowCopyTradeGroup16ParamsSchema = z.object({
  traderAddress: stellarPublicKeySchema,
});

export const listCopyTradesGroup16QuerySchema = z.object({
  status: copyTradeStatusEnum.optional().default('all'),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'limit must be >= 1').max(50, 'limit cannot exceed 50').default(20),
});

export type ListSyndicatesGroup16Query = z.infer<typeof listSyndicatesGroup16QuerySchema>;
export type GetSyndicateGroup16Params = z.infer<typeof getSyndicateGroup16ParamsSchema>;
export type CreateSyndicateGroup16Body = z.infer<typeof createSyndicateGroup16BodySchema>;
export type DepositSyndicateGroup16Body = z.infer<typeof depositSyndicateGroup16BodySchema>;
export type FollowCopyTradeGroup16Body = z.infer<typeof followCopyTradeGroup16BodySchema>;
export type UnfollowCopyTradeGroup16Params = z.infer<typeof unfollowCopyTradeGroup16ParamsSchema>;
export type ListCopyTradesGroup16Query = z.infer<typeof listCopyTradesGroup16QuerySchema>;
