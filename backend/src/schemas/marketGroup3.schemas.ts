import { z } from 'zod';

export const marketStatusEnum = z.enum([
  'open',
  'locked',
  'resolved',
  'cancelled',
  'disputed',
]);

export const listMarketsGroup3QuerySchema = z.object({
  status: marketStatusEnum.optional(),
  category: z.string().trim().min(1).max(50).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  minPool: z.coerce.number().min(0, 'minPool must be >= 0').optional(),
  maxPool: z.coerce.number().min(0, 'maxPool must be >= 0').optional(),
  sort: z
    .enum(['created_desc', 'created_asc', 'pool_desc', 'date_asc', 'date_desc'])
    .default('created_desc'),
  page: z.coerce.number().int().min(1, 'page must be an integer >= 1').default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, 'limit must be >= 1')
    .max(100, 'limit cannot exceed 100')
    .default(20),
});

export const getMarketGroup3ParamsSchema = z.object({
  id: z
    .string()
    .min(1, 'id parameter is required')
    .regex(/^[a-zA-Z0-9_-]+$/, 'id must contain only alphanumeric, hyphen, or underscore characters'),
});

export const createMarketGroup3BodySchema = z.object({
  fighter_a: z
    .string({ required_error: 'fighter_a is required' })
    .trim()
    .min(2, 'fighter_a must be at least 2 characters')
    .max(100, 'fighter_a must not exceed 100 characters'),
  fighter_b: z
    .string({ required_error: 'fighter_b is required' })
    .trim()
    .min(2, 'fighter_b must be at least 2 characters')
    .max(100, 'fighter_b must not exceed 100 characters'),
  weight_class: z
    .string({ required_error: 'weight_class is required' })
    .trim()
    .min(2, 'weight_class is required')
    .max(50, 'weight_class must not exceed 50 characters'),
  venue: z.string().trim().max(100).optional().default('Main Arena'),
  title_fight: z.boolean().optional().default(false),
  scheduled_at: z
    .string({ required_error: 'scheduled_at is required' })
    .datetime({ message: 'scheduled_at must be a valid ISO-8601 datetime string' }),
  fee_bps: z
    .number()
    .int('fee_bps must be an integer')
    .min(0, 'fee_bps cannot be negative')
    .max(1000, 'fee_bps cannot exceed 1000 (10%)')
    .optional()
    .default(200),
  lock_before_secs: z
    .number()
    .int('lock_before_secs must be an integer')
    .min(60, 'lock_before_secs must be at least 60 seconds')
    .max(86400, 'lock_before_secs cannot exceed 86400 seconds (24h)')
    .optional()
    .default(3600),
});

export const lockMarketGroup3ParamsSchema = z.object({
  id: z
    .string()
    .min(1, 'id parameter is required')
    .regex(/^[a-zA-Z0-9_-]+$/, 'id must contain only alphanumeric, hyphen, or underscore characters'),
});

export const lockMarketGroup3BodySchema = z.object({
  reason: z.string().trim().max(255).optional().default('Scheduled fight time reached'),
});

export type ListMarketsGroup3Query = z.infer<typeof listMarketsGroup3QuerySchema>;
export type GetMarketGroup3Params = z.infer<typeof getMarketGroup3ParamsSchema>;
export type CreateMarketGroup3Body = z.infer<typeof createMarketGroup3BodySchema>;
export type LockMarketGroup3Body = z.infer<typeof lockMarketGroup3BodySchema>;
