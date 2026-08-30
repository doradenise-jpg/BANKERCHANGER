import { z } from 'zod';

export const combatSportTypeEnum = z.enum([
  'boxing',
  'mma',
  'kickboxing',
  'bareknuckle',
  'muaythai',
  'other',
]);

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createCategoryGroup14BodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Category name must be at least 2 characters long')
    .max(50, 'Category name cannot exceed 50 characters'),
  slug: z
    .string()
    .trim()
    .min(2, 'Slug must be at least 2 characters long')
    .max(50, 'Slug cannot exceed 50 characters')
    .regex(slugRegex, 'Slug must be lower-case kebab-case (e.g. heavyweight-boxing)'),
  sport_type: combatSportTypeEnum,
  icon_url: z.string().trim().url('Icon URL must be a valid URL').optional(),
  description: z.string().trim().max(500, 'Description cannot exceed 500 characters').optional(),
});

export const categorySlugParamGroup14Schema = z.object({
  slug: z
    .string()
    .trim()
    .min(2, 'Slug must be at least 2 characters long')
    .max(50, 'Slug cannot exceed 50 characters')
    .regex(slugRegex, 'Slug must be valid kebab-case format'),
});

export const listCategoryMarketsGroup14QuerySchema = z.object({
  status: z.enum(['active', 'locked', 'resolved', 'cancelled']).optional(),
  min_odds: z.coerce.number().min(1.01, 'Minimum odds must be >= 1.01').optional(),
  max_odds: z.coerce.number().max(100.0, 'Maximum odds cannot exceed 100.0').optional(),
  page: z.coerce.number().int().min(1, 'Page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'Limit must be >= 1').max(100, 'Limit cannot exceed 100').default(20),
});

export const liveOddsQueryGroup14Schema = z.object({
  sport_type: combatSportTypeEnum.optional(),
  active_only: z.coerce.boolean().default(true),
  sort_by: z.enum(['pool_size', 'scheduled_at', 'spread']).default('pool_size'),
  page: z.coerce.number().int().min(1, 'Page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'Limit must be >= 1').max(50, 'Limit cannot exceed 50').default(20),
});

export const batchTagMarketsGroup14BodySchema = z.object({
  market_ids: z
    .array(z.string().trim().min(1, 'Market ID cannot be empty'))
    .min(1, 'At least one market ID required')
    .max(50, 'Cannot tag more than 50 markets at once'),
  tags: z
    .array(z.string().trim().min(2, 'Tag must be at least 2 characters').max(30, 'Tag cannot exceed 30 characters'))
    .min(1, 'At least one tag required')
    .max(10, 'Cannot attach more than 10 tags per batch'),
});

export const searchSuggestGroup14QuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(2, 'Search query must be at least 2 characters long')
    .max(100, 'Search query cannot exceed 100 characters'),
  limit: z.coerce.number().int().min(1, 'Limit must be >= 1').max(20, 'Limit cannot exceed 20').default(10),
});

export type CreateCategoryGroup14Body = z.infer<typeof createCategoryGroup14BodySchema>;
export type CategorySlugParamGroup14 = z.infer<typeof categorySlugParamGroup14Schema>;
export type ListCategoryMarketsGroup14Query = z.infer<typeof listCategoryMarketsGroup14QuerySchema>;
export type LiveOddsQueryGroup14 = z.infer<typeof liveOddsQueryGroup14Schema>;
export type BatchTagMarketsGroup14Body = z.infer<typeof batchTagMarketsGroup14BodySchema>;
export type SearchSuggestGroup14Query = z.infer<typeof searchSuggestGroup14QuerySchema>;
