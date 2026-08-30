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

export const affiliateTierEnum = z.enum(['bronze', 'silver', 'gold', 'platinum', 'partner'], {
  errorMap: () => ({ message: 'tier must be one of: bronze, silver, gold, platinum, partner' }),
});

export const campaignSortByEnum = z.enum(['total_volume', 'referrals_count', 'commissions_earned', 'created_at'], {
  errorMap: () => ({ message: 'sort_by must be one of: total_volume, referrals_count, commissions_earned, created_at' }),
});

// --- Schemas ---

export const createReferralCodeGroup18BodySchema = z.object({
  code: z
    .string({ required_error: 'code is required' })
    .trim()
    .min(3, 'code must be at least 3 characters')
    .max(20, 'code cannot exceed 20 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'code may only contain letters, numbers, hyphens, and underscores'),
  rebate_percentage_bps: z.coerce
    .number()
    .int()
    .min(0, 'rebate_percentage_bps must be >= 0')
    .max(5000, 'rebate_percentage_bps cannot exceed 5000 (50%)')
    .default(0),
  campaign_name: sanitizedString(2, 50).optional(),
  creator_address: stellarPublicKeySchema,
});

export const applyReferralCodeGroup18BodySchema = z.object({
  referral_code: z
    .string({ required_error: 'referral_code is required' })
    .trim()
    .min(3, 'referral_code must be at least 3 characters')
    .max(20, 'referral_code cannot exceed 20 characters'),
  referee_address: stellarPublicKeySchema,
});

export const claimAffiliatePayoutGroup18BodySchema = z.object({
  recipient_address: stellarPublicKeySchema,
  amount_stroops: z
    .string()
    .regex(/^\d+$/, 'amount_stroops must be a numeric string')
    .refine((val) => {
      try {
        return BigInt(val) > 0n;
      } catch {
        return false;
      }
    }, { message: 'amount_stroops must be greater than zero' })
    .optional(),
  destination_memo: z.string().trim().max(28, 'destination_memo cannot exceed 28 characters').optional(),
});

export const listCampaignsGroup18QuerySchema = z.object({
  status: z.enum(['active', 'expired', 'all']).optional().default('all'),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'limit must be >= 1').max(100, 'limit cannot exceed 100').default(20),
  sort_by: campaignSortByEnum.optional().default('created_at'),
  sort_order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const overrideAffiliateTierGroup18BodySchema = z.object({
  user_id: z.string().trim().min(1, 'user_id is required'),
  tier: affiliateTierEnum,
  custom_commission_bps: z.coerce
    .number()
    .int()
    .min(100, 'custom_commission_bps must be at least 100 (1%)')
    .max(5000, 'custom_commission_bps cannot exceed 5000 (50%)'),
  reason: sanitizedString(5, 255),
});

export const getAffiliateStatsGroup18QuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d', 'all_time']).optional().default('30d'),
});

export type CreateReferralCodeGroup18Body = z.infer<typeof createReferralCodeGroup18BodySchema>;
export type ApplyReferralCodeGroup18Body = z.infer<typeof applyReferralCodeGroup18BodySchema>;
export type ClaimAffiliatePayoutGroup18Body = z.infer<typeof claimAffiliatePayoutGroup18BodySchema>;
export type ListCampaignsGroup18Query = z.infer<typeof listCampaignsGroup18QuerySchema>;
export type OverrideAffiliateTierGroup18Body = z.infer<typeof overrideAffiliateTierGroup18BodySchema>;
export type GetAffiliateStatsGroup18Query = z.infer<typeof getAffiliateStatsGroup18QuerySchema>;
