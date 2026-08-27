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

export const leaderboardPeriodEnum = z.enum(['daily', 'weekly', 'monthly', 'all_time'], {
  errorMap: () => ({ message: 'period must be one of: daily, weekly, monthly, all_time' }),
});

export const marketCategoryEnum = z.enum(['BOXING', 'MMA', 'KICKBOXING', 'ALL'], {
  errorMap: () => ({ message: 'category must be one of: BOXING, MMA, KICKBOXING, ALL' }),
});

export const leaderboardSortByEnum = z.enum(['win_rate', 'net_profit', 'total_volume', 'rank_points'], {
  errorMap: () => ({ message: 'sort_by must be one of: win_rate, net_profit, total_volume, rank_points' }),
});

export const sortOrderEnum = z.enum(['asc', 'desc'], {
  errorMap: () => ({ message: 'sort_order must be asc or desc' }),
});

export const tournamentStatusEnum = z.enum(['upcoming', 'active', 'completed', 'cancelled'], {
  errorMap: () => ({ message: 'status must be one of: upcoming, active, completed, cancelled' }),
});

// --- Schemas ---

export const listLeaderboardsGroup15QuerySchema = z.object({
  period: leaderboardPeriodEnum.optional().default('all_time'),
  category: marketCategoryEnum.optional().default('ALL'),
  min_bets: z.coerce.number().int().min(0, 'min_bets must be >= 0').optional().default(0),
  sort_by: leaderboardSortByEnum.optional().default('rank_points'),
  sort_order: sortOrderEnum.optional().default('desc'),
  page: z.coerce.number().int().min(1, 'page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'limit must be >= 1').max(100, 'limit cannot exceed 100').default(20),
});

export const getTournamentGroup15ParamsSchema = z.object({
  tournamentId: z.string().trim().min(1, 'tournamentId is required'),
});

export const joinTournamentGroup15BodySchema = z.object({
  tournament_id: z.string().trim().min(1, 'tournament_id is required'),
  entry_fee_stroops: z
    .string({ required_error: 'entry_fee_stroops is required' })
    .regex(/^\d+$/, 'entry_fee_stroops must be a positive numeric string in stroops')
    .refine((val) => {
      try {
        return BigInt(val) >= 0n;
      } catch {
        return false;
      }
    }, { message: 'entry_fee_stroops must be a valid non-negative integer' }),
  participant_address: stellarPublicKeySchema,
});

export const getUserRankGroup15ParamsSchema = z.object({
  userId: z.string().trim().min(1, 'userId is required'),
});

export const getUserRankGroup15QuerySchema = z.object({
  period: leaderboardPeriodEnum.optional().default('all_time'),
  season_id: z.string().trim().optional(),
});

export const createTournamentGroup15BodySchema = z
  .object({
    name: sanitizedString(3, 100),
    description: sanitizedString(10, 1000),
    category: marketCategoryEnum.default('ALL'),
    entry_fee_stroops: z
      .string({ required_error: 'entry_fee_stroops is required' })
      .regex(/^\d+$/, 'entry_fee_stroops must be a numeric stroop string'),
    prize_pool_stroops: z
      .string({ required_error: 'prize_pool_stroops is required' })
      .regex(/^\d+$/, 'prize_pool_stroops must be a numeric stroop string')
      .refine((val) => {
        try {
          return BigInt(val) > 0n;
        } catch {
          return false;
        }
      }, { message: 'prize_pool_stroops must be greater than zero' }),
    start_time: z
      .string({ required_error: 'start_time is required' })
      .datetime({ message: 'start_time must be a valid ISO 8601 datetime string' }),
    end_time: z
      .string({ required_error: 'end_time is required' })
      .datetime({ message: 'end_time must be a valid ISO 8601 datetime string' }),
    max_participants: z.coerce.number().int().min(2, 'max_participants must be at least 2').max(10000, 'max_participants cannot exceed 10000').default(100),
    rules: z.array(z.string().trim().min(1)).optional().default([]),
  })
  .refine(
    (data) => new Date(data.end_time) > new Date(data.start_time),
    { message: 'end_time must be strictly after start_time', path: ['end_time'] }
  );

export const finalizeTournamentGroup15BodySchema = z.object({
  tournament_id: z.string().trim().min(1, 'tournament_id is required'),
  winners: z
    .array(
      z.object({
        rank: z.number().int().min(1).max(100),
        user_id: z.string().trim().min(1),
        prize_stroops: z.string().regex(/^\d+$/, 'prize_stroops must be numeric string'),
        payout_address: stellarPublicKeySchema,
      })
    )
    .min(1, 'At least one winner must be specified'),
  admin_notes: z.string().trim().max(1000).optional(),
});

export type ListLeaderboardsGroup15Query = z.infer<typeof listLeaderboardsGroup15QuerySchema>;
export type GetTournamentGroup15Params = z.infer<typeof getTournamentGroup15ParamsSchema>;
export type JoinTournamentGroup15Body = z.infer<typeof joinTournamentGroup15BodySchema>;
export type GetUserRankGroup15Params = z.infer<typeof getUserRankGroup15ParamsSchema>;
export type GetUserRankGroup15Query = z.infer<typeof getUserRankGroup15QuerySchema>;
export type CreateTournamentGroup15Body = z.infer<typeof createTournamentGroup15BodySchema>;
export type FinalizeTournamentGroup15Body = z.infer<typeof finalizeTournamentGroup15BodySchema>;
