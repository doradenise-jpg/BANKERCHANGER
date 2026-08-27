// ============================================================
// BANKERCHANGER — REST Endpoint Group 16: Social Syndicates & Copy-Trading
// Addresses Issue #440 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import {
  listSyndicatesGroup16QuerySchema,
  getSyndicateGroup16ParamsSchema,
  createSyndicateGroup16BodySchema,
  depositSyndicateGroup16BodySchema,
  followCopyTradeGroup16BodySchema,
  unfollowCopyTradeGroup16ParamsSchema,
  listCopyTradesGroup16QuerySchema,
} from '../schemas/socialGroup16.schemas';
import { validateBody, validateParams, validateQuery } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';

const router = Router();

// Rate limiters for Group 16
const queryLimiter = rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' });
const copyTradeLimiter = rateLimit({ windowMs: 60_000, max: 20, keyBy: 'userId' });
const depositLimiter = rateLimit({ windowMs: 60_000, max: 15, keyBy: 'userId' });

/**
 * @swagger
 * tags:
 *   name: Social Group 16
 *   description: Betting Syndicates, Social Pools & Copy-Trading Pipeline (API Group 16)
 */

/**
 * @swagger
 * /api/v2/social/syndicates:
 *   get:
 *     summary: List betting syndicates with performance and capacity filters
 *     tags: [Social Group 16]
 */
router.get(
  '/syndicates',
  queryLimiter,
  validateQuery(listSyndicatesGroup16QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, category, search, page, limit, sort_by, sort_order } = req.query as unknown as {
        status: string;
        category: string;
        search?: string;
        page: number;
        limit: number;
        sort_by: string;
        sort_order: string;
      };

      const offset = (page - 1) * limit;

      const result = await pool.query(
        `SELECT
          s.id,
          s.name,
          s.description,
          s.leader_address,
          s.min_stake_stroops,
          s.max_members,
          s.manager_fee_bps,
          s.is_private,
          s.status,
          s.created_at,
          COALESCE(COUNT(sm.id), 0)::int AS member_count,
          COALESCE(SUM(sm.stake_stroops::numeric), 0)::text AS total_staked_stroops,
          COALESCE(s.roi_bps, 0)::int AS roi_bps
        FROM syndicates s
        LEFT JOIN syndicate_members sm ON sm.syndicate_id = s.id
        WHERE ($1 = 'all' OR s.status = $1)
          AND ($2::text IS NULL OR s.name ILIKE '%' || $2 || '%' OR s.description ILIKE '%' || $2 || '%')
        GROUP BY s.id
        ORDER BY
          CASE WHEN $3 = 'total_staked' AND $4 = 'desc' THEN COALESCE(SUM(sm.stake_stroops::numeric), 0) END DESC,
          CASE WHEN $3 = 'total_staked' AND $4 = 'asc' THEN COALESCE(SUM(sm.stake_stroops::numeric), 0) END ASC,
          CASE WHEN $3 = 'roi_bps' AND $4 = 'desc' THEN COALESCE(s.roi_bps, 0) END DESC,
          CASE WHEN $3 = 'roi_bps' AND $4 = 'asc' THEN COALESCE(s.roi_bps, 0) END ASC,
          CASE WHEN $3 = 'member_count' AND $4 = 'desc' THEN COUNT(sm.id) END DESC,
          CASE WHEN $3 = 'member_count' AND $4 = 'asc' THEN COUNT(sm.id) END ASC,
          s.created_at DESC
        LIMIT $5 OFFSET $6`,
        [status, search || null, sort_by, sort_order, limit, offset]
      );

      res.status(200).json({
        success: true,
        data: {
          page,
          limit,
          total_count: result.rows.length,
          syndicates: result.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/social/syndicates/{syndicateId}:
 *   get:
 *     summary: Retrieve syndicate details, member roster, and ROI stats
 *     tags: [Social Group 16]
 */
router.get(
  '/syndicates/:syndicateId',
  queryLimiter,
  validateParams(getSyndicateGroup16ParamsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { syndicateId } = req.params as unknown as { syndicateId: string };

      const syndicateRes = await pool.query(
        `SELECT s.*, COALESCE(SUM(sm.stake_stroops::numeric), 0)::text AS total_pool_stroops,
                COALESCE(COUNT(sm.id), 0)::int AS current_members
         FROM syndicates s
         LEFT JOIN syndicate_members sm ON sm.syndicate_id = s.id
         WHERE s.id = $1
         GROUP BY s.id`,
        [syndicateId]
      );

      if (syndicateRes.rows.length === 0) {
        throw AppError.notFound(`Syndicate ${syndicateId} not found`);
      }

      const membersRes = await pool.query(
        `SELECT sm.member_address, sm.stake_stroops, sm.joined_at, sm.share_percentage
         FROM syndicate_members sm
         WHERE sm.syndicate_id = $1
         ORDER BY sm.stake_stroops::numeric DESC
         LIMIT 50`,
        [syndicateId]
      );

      res.status(200).json({
        success: true,
        data: {
          syndicate: syndicateRes.rows[0],
          members: membersRes.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/social/syndicates:
 *   post:
 *     summary: Create a new betting syndicate
 *     tags: [Social Group 16]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/syndicates',
  requireAuth,
  depositLimiter,
  validateBody(createSyndicateGroup16BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const {
        name,
        description,
        leader_address,
        min_stake_stroops,
        max_members,
        manager_fee_bps,
        is_private,
        allowed_categories,
      } = req.body;

      const insertRes = await pool.query(
        `INSERT INTO syndicates (
          name, description, creator_id, leader_address, min_stake_stroops,
          max_members, manager_fee_bps, is_private, allowed_categories, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'recruiting', NOW())
        RETURNING *`,
        [
          name,
          description,
          userId,
          leader_address,
          min_stake_stroops,
          max_members,
          manager_fee_bps,
          is_private,
          JSON.stringify(allowed_categories),
        ]
      );

      res.status(201).json({
        success: true,
        message: 'Syndicate created successfully',
        data: insertRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/social/syndicates/{syndicateId}/deposit:
 *   post:
 *     summary: Fund or join a syndicate pool
 *     tags: [Social Group 16]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/syndicates/:syndicateId/deposit',
  requireAuth,
  depositLimiter,
  validateParams(getSyndicateGroup16ParamsSchema),
  validateBody(depositSyndicateGroup16BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { syndicateId } = req.params as unknown as { syndicateId: string };
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { amount_stroops, sender_address, idempotency_key } = req.body;

      const syndicateRes = await pool.query(
        'SELECT id, min_stake_stroops, max_members, status FROM syndicates WHERE id = $1',
        [syndicateId]
      );

      if (syndicateRes.rows.length === 0) {
        throw AppError.notFound(`Syndicate ${syndicateId} not found`);
      }

      const syndicate = syndicateRes.rows[0];
      if (syndicate.status !== 'recruiting' && syndicate.status !== 'active') {
        throw AppError.badRequest(`Cannot deposit into syndicate with status '${syndicate.status}'`);
      }

      if (BigInt(amount_stroops) < BigInt(syndicate.min_stake_stroops)) {
        throw AppError.badRequest(`Deposit amount must be at least min stake (${syndicate.min_stake_stroops} stroops)`);
      }

      const memberRes = await pool.query(
        `INSERT INTO syndicate_members (syndicate_id, user_id, member_address, stake_stroops, idempotency_key, joined_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (syndicate_id, member_address)
         DO UPDATE SET stake_stroops = (syndicate_members.stake_stroops::numeric + EXCLUDED.stake_stroops::numeric)::text
         RETURNING *`,
        [syndicateId, userId, sender_address, amount_stroops, idempotency_key]
      );

      res.status(200).json({
        success: true,
        message: 'Deposit recorded successfully',
        data: memberRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/social/copy-trade/follow:
 *   post:
 *     summary: Follow a top trader and configure automated copy-betting rules
 *     tags: [Social Group 16]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/copy-trade/follow',
  requireAuth,
  copyTradeLimiter,
  validateBody(followCopyTradeGroup16BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const {
        trader_address,
        copy_ratio_bps,
        max_stake_per_bet_stroops,
        daily_stop_loss_stroops,
        max_slippage_bps,
      } = req.body;

      const result = await pool.query(
        `INSERT INTO copy_trading_rules (
          follower_id, target_trader_address, copy_ratio_bps, max_stake_per_bet_stroops,
          daily_stop_loss_stroops, max_slippage_bps, status, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())
        ON CONFLICT (follower_id, target_trader_address)
        DO UPDATE SET
          copy_ratio_bps = EXCLUDED.copy_ratio_bps,
          max_stake_per_bet_stroops = EXCLUDED.max_stake_per_bet_stroops,
          daily_stop_loss_stroops = EXCLUDED.daily_stop_loss_stroops,
          max_slippage_bps = EXCLUDED.max_slippage_bps,
          status = 'active',
          updated_at = NOW()
        RETURNING *`,
        [
          userId,
          trader_address,
          copy_ratio_bps,
          max_stake_per_bet_stroops,
          daily_stop_loss_stroops || null,
          max_slippage_bps,
        ]
      );

      res.status(200).json({
        success: true,
        message: 'Copy-trading subscription active',
        data: result.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/social/copy-trade/unfollow/{traderAddress}:
 *   delete:
 *     summary: Stop copy-trading a specified trader
 *     tags: [Social Group 16]
 *     security:
 *       - bearerAuth: []
 */
router.delete(
  '/copy-trade/unfollow/:traderAddress',
  requireAuth,
  copyTradeLimiter,
  validateParams(unfollowCopyTradeGroup16ParamsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { traderAddress } = req.params as unknown as { traderAddress: string };

      const result = await pool.query(
        `UPDATE copy_trading_rules
         SET status = 'paused', updated_at = NOW()
         WHERE follower_id = $1 AND target_trader_address = $2
         RETURNING *`,
        [userId, traderAddress]
      );

      if (result.rows.length === 0) {
        throw AppError.notFound(`No active copy-trading rule for trader ${traderAddress}`);
      }

      res.status(200).json({
        success: true,
        message: 'Copy-trading paused successfully',
        data: result.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/social/copy-trade/active:
 *   get:
 *     summary: List active copy-trading subscriptions for current user
 *     tags: [Social Group 16]
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/copy-trade/active',
  requireAuth,
  queryLimiter,
  validateQuery(listCopyTradesGroup16QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { status, page, limit } = req.query as unknown as {
        status: string;
        page: number;
        limit: number;
      };

      const offset = (page - 1) * limit;

      const result = await pool.query(
        `SELECT id, target_trader_address, copy_ratio_bps, max_stake_per_bet_stroops,
                daily_stop_loss_stroops, max_slippage_bps, status, updated_at
         FROM copy_trading_rules
         WHERE follower_id = $1 AND ($2 = 'all' OR status = $2)
         ORDER BY updated_at DESC
         LIMIT $3 OFFSET $4`,
        [userId, status, limit, offset]
      );

      res.status(200).json({
        success: true,
        data: {
          page,
          limit,
          total_active: result.rows.length,
          rules: result.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
