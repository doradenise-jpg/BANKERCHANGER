// ============================================================
// BANKERCHANGER — REST Endpoint Group 17: AMM Liquidity & Staking
// Addresses Issue #441 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import {
  listPoolsGroup17QuerySchema,
  getPoolGroup17ParamsSchema,
  addLiquidityGroup17BodySchema,
  removeLiquidityGroup17BodySchema,
  stakeLpGroup17BodySchema,
  claimRewardsGroup17BodySchema,
  getUserPositionsGroup17ParamsSchema,
} from '../schemas/liquidityGroup17.schemas';
import { validateBody, validateParams, validateQuery } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';

const router = Router();

// Rate limiters for Group 17
const queryLimiter = rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' });
const mutationLimiter = rateLimit({ windowMs: 60_000, max: 20, keyBy: 'userId' });
const claimLimiter = rateLimit({ windowMs: 60_000, max: 10, keyBy: 'userId' });

/**
 * @swagger
 * tags:
 *   name: Liquidity Group 17
 *   description: AMM Liquidity Pools, LP Token Mint/Burn & Yield Staking (API Group 17)
 */

/**
 * @swagger
 * /api/v2/liquidity/pools:
 *   get:
 *     summary: List AMM liquidity pools with TVL, APR, and volume stats
 *     tags: [Liquidity Group 17]
 */
router.get(
  '/pools',
  queryLimiter,
  validateQuery(listPoolsGroup17QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { category, min_tvl_stroops, page, limit, sort_by, sort_order } = req.query as unknown as {
        category: string;
        min_tvl_stroops?: string;
        page: number;
        limit: number;
        sort_by: string;
        sort_order: string;
      };

      const offset = (page - 1) * limit;

      const result = await pool.query(
        `SELECT
          m.id AS market_id,
          m.title AS market_title,
          m.category,
          COALESCE(lp.reserve_a_stroops, '0') AS reserve_a_stroops,
          COALESCE(lp.reserve_b_stroops, '0') AS reserve_b_stroops,
          COALESCE(lp.total_lp_tokens, '0') AS total_lp_tokens,
          COALESCE(lp.fee_bps, 30)::int AS fee_bps,
          (COALESCE(lp.reserve_a_stroops::numeric, 0) + COALESCE(lp.reserve_b_stroops::numeric, 0))::text AS tvl_stroops,
          COALESCE(lp.volume_24h_stroops, '0') AS volume_24h_stroops,
          COALESCE(lp.apr_bps, 1250)::int AS apr_bps,
          m.created_at
        FROM markets m
        LEFT JOIN liquidity_pools lp ON lp.market_id = m.id
        WHERE ($1 = 'ALL' OR m.category = $1)
          AND ($2::numeric IS NULL OR (COALESCE(lp.reserve_a_stroops::numeric, 0) + COALESCE(lp.reserve_b_stroops::numeric, 0)) >= $2::numeric)
        ORDER BY
          CASE WHEN $3 = 'tvl' AND $4 = 'desc' THEN (COALESCE(lp.reserve_a_stroops::numeric, 0) + COALESCE(lp.reserve_b_stroops::numeric, 0)) END DESC,
          CASE WHEN $3 = 'tvl' AND $4 = 'asc' THEN (COALESCE(lp.reserve_a_stroops::numeric, 0) + COALESCE(lp.reserve_b_stroops::numeric, 0)) END ASC,
          CASE WHEN $3 = 'volume_24h' AND $4 = 'desc' THEN COALESCE(lp.volume_24h_stroops::numeric, 0) END DESC,
          CASE WHEN $3 = 'volume_24h' AND $4 = 'asc' THEN COALESCE(lp.volume_24h_stroops::numeric, 0) END ASC,
          CASE WHEN $3 = 'apr_bps' AND $4 = 'desc' THEN COALESCE(lp.apr_bps, 0) END DESC,
          CASE WHEN $3 = 'apr_bps' AND $4 = 'asc' THEN COALESCE(lp.apr_bps, 0) END ASC,
          m.created_at DESC
        LIMIT $5 OFFSET $6`,
        [category, min_tvl_stroops || null, sort_by, sort_order, limit, offset]
      );

      res.status(200).json({
        success: true,
        data: {
          page,
          limit,
          total_pools: result.rows.length,
          pools: result.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/liquidity/pools/{marketId}:
 *   get:
 *     summary: Retrieve AMM pool reserves, invariant k, and fee parameters
 *     tags: [Liquidity Group 17]
 */
router.get(
  '/pools/:marketId',
  queryLimiter,
  validateParams(getPoolGroup17ParamsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { marketId } = req.params as unknown as { marketId: string };

      const poolRes = await pool.query(
        `SELECT
          lp.*,
          m.title AS market_title,
          m.status AS market_status,
          (COALESCE(lp.reserve_a_stroops::numeric, 0) * COALESCE(lp.reserve_b_stroops::numeric, 0))::text AS k_invariant
        FROM liquidity_pools lp
        JOIN markets m ON m.id = lp.market_id
        WHERE lp.market_id = $1`,
        [marketId]
      );

      if (poolRes.rows.length === 0) {
        throw AppError.notFound(`Liquidity pool for market ${marketId} not found`);
      }

      res.status(200).json({
        success: true,
        data: poolRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/liquidity/pools/{marketId}/add:
 *   post:
 *     summary: Add liquidity into constant-product AMM pool
 *     tags: [Liquidity Group 17]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/pools/:marketId/add',
  requireAuth,
  mutationLimiter,
  validateParams(getPoolGroup17ParamsSchema),
  validateBody(addLiquidityGroup17BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { marketId } = req.params as unknown as { marketId: string };
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const {
        amount_a_stroops,
        amount_b_stroops,
        min_lp_tokens,
        provider_address,
      } = req.body;

      const poolRes = await pool.query(
        'SELECT id, reserve_a_stroops, reserve_b_stroops, total_lp_tokens FROM liquidity_pools WHERE market_id = $1',
        [marketId]
      );

      if (poolRes.rows.length === 0) {
        throw AppError.notFound(`Liquidity pool for market ${marketId} not found`);
      }

      // Parimutuel / AMM geometric mean mint calculation
      const mintedLpTokens = Math.floor(
        Math.sqrt(Number(amount_a_stroops) * Number(amount_b_stroops))
      ).toString();

      if (BigInt(mintedLpTokens) < BigInt(min_lp_tokens)) {
        throw AppError.badRequest(`Slippage limit reached: minted ${mintedLpTokens} LP tokens is below min ${min_lp_tokens}`);
      }

      const updateRes = await pool.query(
        `UPDATE liquidity_pools
         SET
           reserve_a_stroops = (reserve_a_stroops::numeric + $1::numeric)::text,
           reserve_b_stroops = (reserve_b_stroops::numeric + $2::numeric)::text,
           total_lp_tokens = (total_lp_tokens::numeric + $3::numeric)::text,
           updated_at = NOW()
         WHERE market_id = $4
         RETURNING *`,
        [amount_a_stroops, amount_b_stroops, mintedLpTokens, marketId]
      );

      await pool.query(
        `INSERT INTO lp_positions (pool_id, user_id, provider_address, lp_token_balance, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (pool_id, provider_address)
         DO UPDATE SET lp_token_balance = (lp_positions.lp_token_balance::numeric + EXCLUDED.lp_token_balance::numeric)::text`,
        [updateRes.rows[0].id, userId, provider_address, mintedLpTokens]
      );

      res.status(200).json({
        success: true,
        message: 'Liquidity provided successfully',
        data: {
          market_id: marketId,
          lp_tokens_minted: mintedLpTokens,
          pool: updateRes.rows[0],
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/liquidity/pools/{marketId}/remove:
 *   post:
 *     summary: Remove liquidity by burning LP tokens
 *     tags: [Liquidity Group 17]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/pools/:marketId/remove',
  requireAuth,
  mutationLimiter,
  validateParams(getPoolGroup17ParamsSchema),
  validateBody(removeLiquidityGroup17BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { marketId } = req.params as unknown as { marketId: string };
      const { lp_tokens_to_burn, min_amount_a_stroops, min_amount_b_stroops, provider_address } = req.body;

      const poolRes = await pool.query(
        'SELECT id, reserve_a_stroops, reserve_b_stroops, total_lp_tokens FROM liquidity_pools WHERE market_id = $1',
        [marketId]
      );

      if (poolRes.rows.length === 0) {
        throw AppError.notFound(`Liquidity pool for market ${marketId} not found`);
      }

      const poolData = poolRes.rows[0];
      const totalLp = Number(poolData.total_lp_tokens);
      if (totalLp <= 0 || BigInt(lp_tokens_to_burn) > BigInt(poolData.total_lp_tokens)) {
        throw AppError.badRequest('Cannot burn more LP tokens than existing pool supply');
      }

      const share = Number(lp_tokens_to_burn) / totalLp;
      const amountAOut = Math.floor(Number(poolData.reserve_a_stroops) * share).toString();
      const amountBOut = Math.floor(Number(poolData.reserve_b_stroops) * share).toString();

      if (BigInt(amountAOut) < BigInt(min_amount_a_stroops) || BigInt(amountBOut) < BigInt(min_amount_b_stroops)) {
        throw AppError.badRequest('Slippage tolerance exceeded on liquidity removal');
      }

      const updateRes = await pool.query(
        `UPDATE liquidity_pools
         SET
           reserve_a_stroops = (reserve_a_stroops::numeric - $1::numeric)::text,
           reserve_b_stroops = (reserve_b_stroops::numeric - $2::numeric)::text,
           total_lp_tokens = (total_lp_tokens::numeric - $3::numeric)::text,
           updated_at = NOW()
         WHERE market_id = $4
         RETURNING *`,
        [amountAOut, amountBOut, lp_tokens_to_burn, marketId]
      );

      res.status(200).json({
        success: true,
        message: 'Liquidity withdrawn successfully',
        data: {
          market_id: marketId,
          lp_tokens_burned: lp_tokens_to_burn,
          amount_a_received_stroops: amountAOut,
          amount_b_received_stroops: amountBOut,
          pool: updateRes.rows[0],
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/liquidity/staking/stake:
 *   post:
 *     summary: Stake LP tokens into yield farming reward vault
 *     tags: [Liquidity Group 17]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/staking/stake',
  requireAuth,
  mutationLimiter,
  validateBody(stakeLpGroup17BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { pool_id, lp_token_amount, lock_duration_days, staker_address } = req.body;

      const result = await pool.query(
        `INSERT INTO lp_staking_vault (
          pool_id, user_id, staker_address, staked_amount, lock_duration_days,
          multiplier_bps, staked_at, unlock_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          10000 + ($5 * 50),
          NOW(),
          NOW() + ($5 || ' days')::interval
        ) RETURNING *`,
        [pool_id, userId, staker_address, lp_token_amount, lock_duration_days]
      );

      res.status(201).json({
        success: true,
        message: 'LP tokens staked in yield vault',
        data: result.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/liquidity/staking/claim-rewards:
 *   post:
 *     summary: Claim accumulated LP staking rewards and fees
 *     tags: [Liquidity Group 17]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/staking/claim-rewards',
  requireAuth,
  claimLimiter,
  validateBody(claimRewardsGroup17BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { pool_id, recipient_address } = req.body;

      const rewardRes = await pool.query(
        `SELECT COALESCE(SUM(staked_amount::numeric * 0.05), 0)::text AS claimable_rewards_stroops
         FROM lp_staking_vault
         WHERE pool_id = $1 AND staker_address = $2`,
        [pool_id, recipient_address]
      );

      res.status(200).json({
        success: true,
        message: 'Staking rewards claimed successfully',
        data: {
          pool_id,
          recipient_address,
          claimed_amount_stroops: rewardRes.rows[0]?.claimable_rewards_stroops || '0',
          claimed_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/liquidity/users/{address}/positions:
 *   get:
 *     summary: Retrieve active LP positions and staked vaults for a user
 *     tags: [Liquidity Group 17]
 */
router.get(
  '/users/:address/positions',
  queryLimiter,
  validateParams(getUserPositionsGroup17ParamsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params as unknown as { address: string };

      const positionsRes = await pool.query(
        `SELECT pos.*, lp.market_id, lp.apr_bps
         FROM lp_positions pos
         JOIN liquidity_pools lp ON lp.id = pos.pool_id
         WHERE pos.provider_address = $1`,
        [address]
      );

      const stakedRes = await pool.query(
        `SELECT * FROM lp_staking_vault WHERE staker_address = $1`,
        [address]
      );

      res.status(200).json({
        success: true,
        data: {
          provider_address: address,
          lp_positions: positionsRes.rows,
          staked_vaults: stakedRes.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
