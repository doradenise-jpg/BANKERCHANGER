import { z } from 'zod';

export const timeframeEnum = z.enum(['daily', 'weekly', 'monthly', 'all_time']);
export const leaderboardMetricEnum = z.enum(['pnl', 'roi', 'win_rate', 'volume', 'streak']);
export const sportCategoryEnum = z.enum(['boxing', 'mma', 'kickboxing', 'all']);

const stellarAddressRegex = /^[GC][A-Z2-7]{55}$/;

export const listLeaderboardGroup8QuerySchema = z.object({
  timeframe: timeframeEnum.default('all_time'),
  metric: leaderboardMetricEnum.default('pnl'),
  category: sportCategoryEnum.default('all'),
  page: z.coerce.number().int().min(1, 'Page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'Limit must be >= 1').max(100, 'Limit cannot exceed 100').default(25),
});

export const getUserRankGroup8ParamsSchema = z.object({
  address: z
    .string()
    .trim()
    .regex(stellarAddressRegex, 'User address must be a valid Stellar public key (G... or C...)'),
});

export const createSeasonGroup8BodySchema = z
  .object({
    season_name: z
      .string()
      .trim()
      .min(3, 'Season name must be at least 3 characters long')
      .max(100, 'Season name cannot exceed 100 characters'),
    start_time: z.string().datetime({ message: 'Start time must be a valid ISO 8601 string' }),
    end_time: z.string().datetime({ message: 'End time must be a valid ISO 8601 string' }),
    prize_pool_stroops: z
      .string()
      .trim()
      .regex(/^[1-9]\d*$/, 'Prize pool must be a positive integer stroop string'),
    min_bets_required: z
      .number()
      .int()
      .min(1, 'Minimum bets required must be at least 1')
      .default(5),
    description: z.string().trim().max(1000, 'Description cannot exceed 1000 characters').optional(),
  })
  .refine(
    (data) => new Date(data.end_time).getTime() > new Date(data.start_time).getTime(),
    {
      message: 'End time must be strictly after start time',
      path: ['end_time'],
    }
  );

export const joinSeasonGroup8BodySchema = z.object({
  season_id: z.string().trim().min(1, 'Season ID is required').max(64, 'Season ID too long'),
  terms_accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the tournament terms and conditions' }),
  }),
});

export type ListLeaderboardGroup8Query = z.infer<typeof listLeaderboardGroup8QuerySchema>;
export type GetUserRankGroup8Params = z.infer<typeof getUserRankGroup8ParamsSchema>;
export type CreateSeasonGroup8Body = z.infer<typeof createSeasonGroup8BodySchema>;
export type JoinSeasonGroup8Body = z.infer<typeof joinSeasonGroup8BodySchema>;
