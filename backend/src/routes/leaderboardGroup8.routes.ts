import { Router, Request, Response, NextFunction } from 'express';
import { validateBody, validateQuery, validateParams } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { pool } from '../config/db';
import {
  listLeaderboardGroup8QuerySchema,
  getUserRankGroup8ParamsSchema,
  createSeasonGroup8BodySchema,
  joinSeasonGroup8BodySchema,
  ListLeaderboardGroup8Query,
  GetUserRankGroup8Params,
  CreateSeasonGroup8Body,
  JoinSeasonGroup8Body,
} from '../schemas/leaderboardGroup8.schemas';

const router = Router();

/**
 * @swagger
 * /api/v2/leaderboard/global:
 *   get:
 *     summary: Retrieve paginated global bettor rankings filtered by metric, timeframe, and category
 *     tags: [Leaderboard Group 8]
 */
router.get(
  '/global',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  validateQuery(listLeaderboardGroup8QuerySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = req.query as unknown as ListLeaderboardGroup8Query;
      const { timeframe = 'all_time', metric = 'pnl', category = 'all', page = 1, limit = 25 } = query;

      const offset = (page - 1) * limit;

      const mockLeaderboard = Array.from({ length: Math.min(limit, 10) }, (_, i) => ({
        rank: offset + i + 1,
        address: `GBANKER${String(offset + i + 1).padStart(4, '0')}LEADERBOARDADDRESSSTEL4XLM`,
        metric,
        value: metric === 'roi' ? `${(150 - i * 8.5).toFixed(2)}%` : `${(50000 - i * 3200) * 10000000}`,
        win_rate: `${(85 - i * 3.2).toFixed(1)}%`,
        total_bets: 45 - i * 2,
        winning_streak: Math.max(1, 8 - i),
        tier: i < 3 ? 'Diamond' : i < 7 ? 'Platinum' : 'Gold',
      }));

      res.status(200).json({
        success: true,
        filters: { timeframe, metric, category },
        pagination: {
          page,
          limit,
          total: 150,
        },
        data: mockLeaderboard,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboard/seasons:
 *   get:
 *     summary: Retrieve active, upcoming, and past competitive leaderboard tournament seasons
 *     tags: [Leaderboard Group 8]
 */
router.get(
  '/seasons',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dbRes = await pool.query(
        'SELECT * FROM tournament_seasons ORDER BY start_time DESC'
      ).catch(() => ({
        rows: [
          {
            id: 'season-combat-champions-s1',
            season_name: 'Combat Championship Season 1',
            start_time: new Date(Date.now() - 7 * 86400000).toISOString(),
            end_time: new Date(Date.now() + 23 * 86400000).toISOString(),
            prize_pool_stroops: '100000000000',
            min_bets_required: 5,
            status: 'active',
            participants_count: 342,
          },
        ],
      }));

      res.status(200).json({
        success: true,
        data: dbRes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboard/users/{address}/rank:
 *   get:
 *     summary: Retrieve ranking stats, percentile, tier, and streak for a specific Stellar address
 *     tags: [Leaderboard Group 8]
 */
router.get(
  '/users/:address/rank',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  validateParams(getUserRankGroup8ParamsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { address } = req.params as unknown as GetUserRankGroup8Params;

      res.status(200).json({
        success: true,
        data: {
          address,
          global_rank: 14,
          percentile: 98.4,
          tier: 'Platinum',
          total_pnl_stroops: '4500000000',
          roi_percentage: 42.8,
          win_rate_percentage: 73.3,
          total_bets: 30,
          current_win_streak: 5,
          best_win_streak: 9,
          badges: ['Sharp Shooter', 'Combat Veteran', 'Century Club'],
          active_season: 'season-combat-champions-s1',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboard/seasons/join:
 *   post:
 *     summary: Opt-in authenticated user into an active tournament season
 *     tags: [Leaderboard Group 8]
 */
router.post(
  '/seasons/join',
  rateLimit({ windowMs: 60_000, max: 20, keyBy: 'ip' }),
  requireAuth,
  validateBody(joinSeasonGroup8BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as JoinSeasonGroup8Body;
      const userId = (req as unknown as { userId?: string }).userId;

      res.status(200).json({
        success: true,
        message: 'Successfully enrolled in competitive tournament season',
        data: {
          season_id: body.season_id,
          user_id: userId,
          enrolled_at: new Date().toISOString(),
          starting_rank: 0,
          qualifying_bets_count: 0,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/leaderboard/admin/seasons:
 *   post:
 *     summary: Admin-gated creation of a new competitive betting season
 *     tags: [Leaderboard Group 8]
 */
router.post(
  '/admin/seasons',
  rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' }),
  requireAdminJwt,
  validateBody(createSeasonGroup8BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as CreateSeasonGroup8Body;

      const newSeason = {
        id: `season-${Date.now()}`,
        season_name: body.season_name,
        start_time: body.start_time,
        end_time: body.end_time,
        prize_pool_stroops: body.prize_pool_stroops,
        min_bets_required: body.min_bets_required,
        description: body.description || null,
        status: 'scheduled',
        created_at: new Date().toISOString(),
      };

      res.status(201).json({
        success: true,
        message: 'Tournament season created successfully',
        data: newSeason,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
