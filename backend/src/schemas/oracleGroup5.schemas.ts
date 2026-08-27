import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

const stellarAddressSchema = z
  .string({ required_error: 'Stellar address is required' })
  .trim()
  .refine((v) => StrKey.isValidEd25519PublicKey(v), {
    message: 'Invalid Stellar public key format',
  });

export const oracleOutcomeEnum = z.enum([
  'fighter_a',
  'fighter_b',
  'draw',
  'no_contest',
]);

export const submitOracleReportGroup5BodySchema = z.object({
  match_id: z.string({ required_error: 'match_id is required' }).trim().min(1).max(64),
  market_id: z.string({ required_error: 'market_id is required' }).trim().min(1).max(64),
  outcome: oracleOutcomeEnum,
  reported_at: z
    .string({ required_error: 'reported_at is required' })
    .datetime({ message: 'reported_at must be an ISO-8601 string' }),
  oracle_address: stellarAddressSchema,
  signature: z
    .string({ required_error: 'signature is required' })
    .regex(/^[a-fA-F0-9]{128}$/, 'signature must be a valid 64-byte Ed25519 hex string (128 hex chars)'),
});

export const flagDisputeGroup5BodySchema = z.object({
  market_id: z.string({ required_error: 'market_id is required' }).trim().min(1),
  initiator_address: stellarAddressSchema,
  reason: z
    .string({ required_error: 'reason is required' })
    .trim()
    .min(10, 'reason must be at least 10 characters')
    .max(500, 'reason cannot exceed 500 characters'),
  evidence_url: z.string().url('evidence_url must be a valid URL').optional(),
});

export const resolveDisputeGroup5BodySchema = z.object({
  market_id: z.string({ required_error: 'market_id is required' }).trim().min(1),
  final_outcome: oracleOutcomeEnum,
  resolution_notes: z
    .string({ required_error: 'resolution_notes is required' })
    .trim()
    .min(5, 'resolution_notes must be at least 5 characters')
    .max(1000, 'resolution_notes cannot exceed 1000 characters'),
  totp_code: z
    .string({ required_error: 'totp_code is required' })
    .regex(/^\d{6}$/, 'totp_code must be a 6-digit numeric string'),
});

export const listDisputesGroup5QuerySchema = z.object({
  status: z.enum(['pending', 'investigating', 'resolved', 'dismissed']).optional(),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'limit must be >= 1')
    .max(100, 'limit cannot exceed 100')
    .default(20),
});

export type SubmitOracleReportGroup5Body = z.infer<typeof submitOracleReportGroup5BodySchema>;
export type FlagDisputeGroup5Body = z.infer<typeof flagDisputeGroup5BodySchema>;
export type ResolveDisputeGroup5Body = z.infer<typeof resolveDisputeGroup5BodySchema>;
export type ListDisputesGroup5Query = z.infer<typeof listDisputesGroup5QuerySchema>;
