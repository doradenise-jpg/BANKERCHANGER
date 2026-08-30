import { z } from 'zod';

export const userRoleEnum = z.enum(['user', 'moderator', 'admin', 'oracle']);
export const kycTierEnum = z.enum(['tier_0', 'tier_1', 'tier_2', 'tier_3']);

export const updateProfileGroup6BodySchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3, 'username must be at least 3 characters')
      .max(30, 'username cannot exceed 30 characters')
      .regex(/^[a-zA-Z0-9_]+$/, 'username may only contain alphanumeric characters and underscores')
      .optional(),
    email: z.string().trim().email('Invalid email address format').optional(),
    avatar_url: z.string().trim().url('avatar_url must be a valid URL').optional(),
    notifications_enabled: z.boolean().optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one profile field must be provided for update' }
  );

export const submitKycGroup6BodySchema = z.object({
  full_name: z
    .string({ required_error: 'full_name is required' })
    .trim()
    .min(2, 'full_name must be at least 2 characters')
    .max(100, 'full_name cannot exceed 100 characters'),
  country_code: z
    .string({ required_error: 'country_code is required' })
    .trim()
    .length(2, 'country_code must be a 2-letter ISO 3166-1 alpha-2 code')
    .toUpperCase(),
  document_type: z.enum(['passport', 'national_id', 'drivers_license']),
  document_hash: z
    .string({ required_error: 'document_hash is required' })
    .regex(/^[a-fA-F0-9]{64}$/, 'document_hash must be a 64-character SHA-256 hex string'),
  requested_tier: z.enum(['tier_1', 'tier_2', 'tier_3']),
});

export const updateRoleGroup6ParamsSchema = z.object({
  id: z.string().min(1, 'id parameter is required'),
});

export const updateRoleGroup6BodySchema = z.object({
  role: userRoleEnum,
  reason: z.string().trim().max(255).optional().default('Role updated by administrator'),
});

export const listUsersGroup6QuerySchema = z.object({
  role: userRoleEnum.optional(),
  kyc_tier: kycTierEnum.optional(),
  search: z.string().trim().max(50).optional(),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'limit must be >= 1')
    .max(100, 'limit cannot exceed 100')
    .default(20),
});

export type UpdateProfileGroup6Body = z.infer<typeof updateProfileGroup6BodySchema>;
export type SubmitKycGroup6Body = z.infer<typeof submitKycGroup6BodySchema>;
export type UpdateRoleGroup6Params = z.infer<typeof updateRoleGroup6ParamsSchema>;
export type UpdateRoleGroup6Body = z.infer<typeof updateRoleGroup6BodySchema>;
export type ListUsersGroup6Query = z.infer<typeof listUsersGroup6QuerySchema>;
