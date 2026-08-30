import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

const stellarAddressSchema = z
  .string({ required_error: 'Stellar address is required' })
  .trim()
  .refine((v) => StrKey.isValidEd25519PublicKey(v), {
    message: 'Invalid Stellar public key format (must start with G and be 56 characters)',
  });

export const betSideEnum = z.enum(['fighter_a', 'fighter_b', 'draw']);

export const placeBetGroup4BodySchema = z.object({
  market_id: z
    .string({ required_error: 'market_id is required' })
    .trim()
    .min(1, 'market_id cannot be empty'),
  bettor_address: stellarAddressSchema,
  side: betSideEnum,
  amount: z
    .string({ required_error: 'amount is required' })
    .regex(/^[1-9]\d*$/, 'amount must be a positive integer in stroops (string)'),
  max_slippage_bps: z
    .number()
    .int('max_slippage_bps must be an integer')
    .min(0, 'max_slippage_bps cannot be negative')
    .max(5000, 'max_slippage_bps cannot exceed 5000 (50%)')
    .optional()
    .default(500),
  idempotency_key: z
    .string()
    .trim()
    .min(8, 'idempotency_key must be at least 8 characters')
    .max(128, 'idempotency_key cannot exceed 128 characters')
    .optional(),
});

export const getUserBetsGroup4ParamsSchema = z.object({
  address: stellarAddressSchema,
});

export const getUserBetsGroup4QuerySchema = z.object({
  status: z.enum(['open', 'locked', 'resolved', 'cancelled']).optional(),
  claimed: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'limit must be >= 1')
    .max(100, 'limit cannot exceed 100')
    .default(20),
});

export const calculatePayoutGroup4BodySchema = z.object({
  market_id: z.string({ required_error: 'market_id is required' }).trim().min(1),
  amount: z
    .string({ required_error: 'amount is required' })
    .regex(/^[1-9]\d*$/, 'amount must be a positive integer in stroops'),
  side: betSideEnum,
});

export const batchPayoutGroup4BodySchema = z.object({
  simulations: z
    .array(calculatePayoutGroup4BodySchema)
    .min(1, 'At least one simulation must be provided')
    .max(20, 'Cannot exceed 20 simulations per batch'),
});

export type PlaceBetGroup4Body = z.infer<typeof placeBetGroup4BodySchema>;
export type GetUserBetsGroup4Params = z.infer<typeof getUserBetsGroup4ParamsSchema>;
export type GetUserBetsGroup4Query = z.infer<typeof getUserBetsGroup4QuerySchema>;
export type CalculatePayoutGroup4Body = z.infer<typeof calculatePayoutGroup4BodySchema>;
export type BatchPayoutGroup4Body = z.infer<typeof batchPayoutGroup4BodySchema>;
