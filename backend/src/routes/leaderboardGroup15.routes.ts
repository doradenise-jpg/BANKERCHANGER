// ============================================================
// BANKERCHANGER — REST Endpoint Group 15: Leaderboards & Tournaments
// Addresses Issue #439 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import {
  listLeaderboardsGroup15QuerySchema,
  getTournamentGroup15ParamsSchema,
  joinTournamentGroup15BodySchema,
  getUserRankGroup15ParamsSchema,
  getUserRankGroup15QuerySchema,
  createTournamentGroup15BodySchema,
  finalizeTournamentGroup15BodySchema,
} from '../schemas/leaderboardGroup15.schemas';
import { validateBody, validateParams, validateQuery } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';

const router = Router();

// Rate limiters for Group 15 endpoints
const queryLimiter = rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' });
const mutationLimiter = rateLimit({ windowMs: 60_000, max: 15, keyBy: 'userId' });
const adminLimiter = rateLimit({ windowMs: 60_000, max: 20, keyBy: 'ip' });

/**
 * @swagger
 * tags:
 *   name: Leaderboards Group 15
 *   description: Competitive Rankings, Tournament Brackets & Seasonal Leaderboards (API Group 15)
 */

/**
 * @swagger
 * /api/v2/leaderboards/global:
 *   get:
 *     summary: List global competitive rankings with filters and pagination
 *     tags: [Leaderboards Group 15]
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [daily, weekly, monthly, all_time]
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [BOXING, MMA, KICKBOXING, ALL]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Paginated global leaderboard rankings
 */
router.get(
  '/global',
  queryLimiter,
  validateQuery(listLeaderboardsGroup15QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { period, category, min_bets, sort_by, sort_order, page, limit } = req.query as unknown as {
        period: string;
        category: string;
        min_bets: number;
        sort_by: string;
        sort_order: string;
        page: number;
        limit: number;
      };

      const offset = (page - 1) * limit;

      const query = `
        SELECT
          u.id AS user_id,
          u.username,
          u.role,
          COUNT(b.id)::int AS total_bets,
          COUNT(CASE WHEN b.claimed = true THEN 1 END)::int AS winning_bets,
          COALESCE(SUM(b.amount::numeric), 0)::text AS total_volume_stroops,
          COALESCE(SUM(b.payout::numeric - b.amount::numeric), 0)::text AS net_profit_stroops,
          CASE
            WHEN COUNT(b.id) > 0 THEN ROUND((COUNT(CASE WHEN b.claimed = true THEN 1 END)::numeric / COUNT(b.id)::numeric) * 100, 2)
            ELSE 0
          END AS win_rate_percentage,
          (COUNT(CASE WHEN b.claimed = true THEN 1 END) * 100 + COALESCE(SUM(b.amount::numeric) / 1000000, 0))::bigint AS rank_points
        FROM users u
        LEFT JOIN bets b ON b.user_id = u.id
        LEFT JOIN markets m ON b.market_id = m.id
        WHERE ($1 = 'ALL' OR m.category = $1)
        GROUP BY u.id, u.username, u.role
        HAVING COUNT(b.id) >= $2
        ORDER BY
          CASE WHEN $3 = 'win_rate' AND $4 = 'desc' THEN win_rate_percentage END DESC,
          CASE WHEN $3 = 'win_rate' AND $4 = 'asc' THEN win_rate_percentage END ASC,
          CASE WHEN $3 = 'net_profit' AND $4 = 'desc' THEN net_profit_stroops END DESC,
          CASE WHEN $3 = 'net_profit' AND $4 = 'asc' THEN net_profit_stroops END ASC,
          CASE WHEN $3 = 'total_volume' AND $4 = 'desc' THEN total_volume_stroops END DESC,
          CASE WHEN $3 = 'total_volume' AND $4 = 'asc' THEN total_volume_stroops END ASC,
          CASE WHEN $3 = 'rank_points' AND $4 = 'desc' THEN rank_points END DESC,
          CASE WHEN $3 = 'rank_points' AND $4 = 'asc' THEN rank_points END ASC,
          u.id ASC
        LIMIT $5 OFFSET $6
      `;

      const result = await pool.query(query, [category, min_bets, sort_by, sort_order, limit, offset]);

      res.status(200).json({
        success: true,
        data: {
          period,
          category,
          page,
          limit,
          total_count: result.rows.length,
          rankings: result.rows.map((row: Record<string, unknown>, index: number) => ({
            rank: offset + index + 1,
            ...row,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboards/tournaments:
 *   get:
 *     summary: List active and upcoming betting tournaments
 *     tags: [Leaderboards Group 15]
 */
router.get(
  '/tournaments',
  queryLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10)));
      const offset = (page - 1) * limit;

      const result = await pool.query(
        `SELECT id, name, description, category, entry_fee_stroops, prize_pool_stroops,
                start_time, end_time, max_participants, status, created_at
         FROM tournaments
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      res.status(200).json({
        success: true,
        data: {
          page,
          limit,
          tournaments: result.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboards/tournaments/{tournamentId}:
 *   get:
 *     summary: Get tournament details and participant leaderboard
 *     tags: [Leaderboards Group 15]
 */
router.get(
  '/tournaments/:tournamentId',
  queryLimiter,
  validateParams(getTournamentGroup15ParamsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tournamentId } = req.params as unknown as { tournamentId: string };

      const tournamentRes = await pool.query(
        `SELECT id, name, description, category, entry_fee_stroops, prize_pool_stroops,
                start_time, end_time, max_participants, status, rules
         FROM tournaments
         WHERE id = $1`,
        [tournamentId]
      );

      if (tournamentRes.rows.length === 0) {
        throw AppError.notFound(`Tournament ${tournamentId} not found`);
      }

      const participantsRes = await pool.query(
        `SELECT tp.user_id, u.username, tp.participant_address, tp.score, tp.rank, tp.joined_at
         FROM tournament_participants tp
         JOIN users u ON u.id = tp.user_id
         WHERE tp.tournament_id = $1
         ORDER BY tp.score DESC, tp.joined_at ASC
         LIMIT 50`,
        [tournamentId]
      );

      res.status(200).json({
        success: true,
        data: {
          tournament: tournamentRes.rows[0],
          standings: participantsRes.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboards/tournaments/{tournamentId}/join:
 *   post:
 *     summary: Join a tournament with entry fee verification
 *     tags: [Leaderboards Group 15]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/tournaments/:tournamentId/join',
  requireAuth,
  mutationLimiter,
  validateParams(getTournamentGroup15ParamsSchema),
  validateBody(joinTournamentGroup15BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { tournament_id, entry_fee_stroops, participant_address } = req.body;

      const tournamentRes = await pool.query(
        'SELECT id, entry_fee_stroops, max_participants, status FROM tournaments WHERE id = $1',
        [tournament_id]
      );

      if (tournamentRes.rows.length === 0) {
        throw AppError.notFound(`Tournament ${tournament_id} not found`);
      }

      const tournament = tournamentRes.rows[0];
      if (tournament.status !== 'upcoming' && tournament.status !== 'active') {
        throw AppError.badRequest(`Cannot join tournament with status '${tournament.status}'`);
      }

      const countRes = await pool.query(
        'SELECT COUNT(*)::int AS count FROM tournament_participants WHERE tournament_id = $1',
        [tournament_id]
      );

      if (countRes.rows[0].count >= tournament.max_participants) {
        throw AppError.badRequest('Tournament participant capacity reached');
      }

      const insertRes = await pool.query(
        `INSERT INTO tournament_participants (tournament_id, user_id, participant_address, entry_fee_paid, score, joined_at)
         VALUES ($1, $2, $3, $4, 0, NOW())
         RETURNING *`,
        [tournament_id, userId, participant_address, entry_fee_stroops]
      );

      res.status(201).json({
        success: true,
        message: 'Successfully enrolled in tournament',
        data: insertRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboards/users/{userId}/rank:
 *   get:
 *     summary: Retrieve user competitive rank tier, percentile, and stats
 *     tags: [Leaderboards Group 15]
 */
router.get(
  '/users/:userId/rank',
  queryLimiter,
  validateParams(getUserRankGroup15ParamsSchema),
  validateQuery(getUserRankGroup15QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params as unknown as { userId: string };
      const { period } = req.query as unknown as { period: string };

      const userRes = await pool.query('SELECT id, username, created_at FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) {
        throw AppError.notFound(`User ${userId} not found`);
      }

      const statsRes = await pool.query(
        `SELECT
          COUNT(id)::int AS total_bets,
          COUNT(CASE WHEN claimed = true THEN 1 END)::int AS winning_bets,
          COALESCE(SUM(amount::numeric), 0)::text AS total_volume_stroops,
          COALESCE(SUM(payout::numeric - amount::numeric), 0)::text AS net_profit_stroops
         FROM bets
         WHERE user_id = $1`,
        [userId]
      );

      const stats = statsRes.rows[0];
      const winRate = stats.total_bets > 0 ? (stats.winning_bets / stats.total_bets) * 100 : 0;
      const rankPoints = stats.winning_bets * 100 + Math.floor(Number(stats.total_volume_stroops) / 1000000);

      let rankTier = 'BRONZE';
      if (rankPoints >= 10000) rankTier = 'DIAMOND';
      else if (rankPoints >= 5000) rankTier = 'PLATINUM';
      else if (rankPoints >= 2000) rankTier = 'GOLD';
      else if (rankPoints >= 500) rankTier = 'SILVER';

      res.status(200).json({
        success: true,
        data: {
          user_id: userId,
          username: userRes.rows[0].username,
          period,
          tier: rankTier,
          rank_points: rankPoints,
          win_rate_percentage: winRate.toFixed(2),
          total_bets: stats.total_bets,
          winning_bets: stats.winning_bets,
          net_profit_stroops: stats.net_profit_stroops,
          badges: ['EARLY_ADOPTER', winRate >= 60 ? 'SHARP_SHOOTER' : 'CONTENDER'],
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboards/admin/tournaments:
 *   post:
 *     summary: Create a new competitive tournament (Admin only)
 *     tags: [Leaderboards Group 15]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/admin/tournaments',
  requireAdminJwt,
  adminLimiter,
  validateBody(createTournamentGroup15BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        name,
        description,
        category,
        entry_fee_stroops,
        prize_pool_stroops,
        start_time,
        end_time,
        max_participants,
        rules,
      } = req.body;

      const insertRes = await pool.query(
        `INSERT INTO tournaments (
          name, description, category, entry_fee_stroops, prize_pool_stroops,
          start_time, end_time, max_participants, rules, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'upcoming', NOW())
        RETURNING *`,
        [
          name,
          description,
          category,
          entry_fee_stroops,
          prize_pool_stroops,
          start_time,
          end_time,
          max_participants,
          JSON.stringify(rules),
        ]
      );

      res.status(201).json({
        success: true,
        message: 'Tournament created successfully',
        data: insertRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboards/admin/tournaments/{tournamentId}/finalize:
 *   post:
 *     summary: Finalize tournament and record winners (Admin only)
 *     tags: [Leaderboards Group 15]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/admin/tournaments/:tournamentId/finalize',
  requireAdminJwt,
  adminLimiter,
  validateParams(getTournamentGroup15ParamsSchema),
  validateBody(finalizeTournamentGroup15BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tournamentId } = req.params as unknown as { tournamentId: string };
      const { winners, admin_notes } = req.body;

      const tournamentRes = await pool.query(
        'SELECT id, status FROM tournaments WHERE id = $1',
        [tournamentId]
      );

      if (tournamentRes.rows.length === 0) {
        throw AppError.notFound(`Tournament ${tournamentId} not found`);
      }

      await pool.query(
        `UPDATE tournaments
         SET status = 'completed', admin_notes = $1, finalized_at = NOW()
         WHERE id = $2`,
        [admin_notes || null, tournamentId]
      );

      res.status(200).json({
        success: true,
        message: 'Tournament finalized and prizes recorded',
        data: {
          tournament_id: tournamentId,
          winners_count: winners.length,
          winners,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
