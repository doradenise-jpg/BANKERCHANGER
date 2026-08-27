// ============================================================
// BANKERCHANGER — REST Endpoint Group 3: Market Discovery & Lifecycle
// Addresses Issue #431 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import {
  listMarketsGroup3QuerySchema,
  getMarketGroup3ParamsSchema,
  createMarketGroup3BodySchema,
  lockMarketGroup3ParamsSchema,
  lockMarketGroup3BodySchema,
} from '../schemas/marketGroup3.schemas';
import { validateQuery, validateParams, validateBody } from '../api/middleware/validate';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';

const router = Router();

// Rate limiter for market creation (10 requests per minute)
const createMarketLimiter = rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' });

/**
 * @swagger
 * tags:
 *   name: Market Group 3
 *   description: Enhanced Market Discovery & Lifecycle Management (API Group 3)
 */

/**
 * @swagger
 * /api/v2/markets:
 *   get:
 *     summary: List markets with advanced filtering and pagination
 *     tags: [Market Group 3]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [open, locked, resolved, cancelled, disputed]
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: minPool
 *         schema:
 *           type: number
 *       - in: query
 *         name: maxPool
 *         schema:
 *           type: number
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [created_desc, created_asc, pool_desc, date_asc, date_desc]
 *           default: created_desc
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Paginated list of markets
 *       422:
 *         description: Query validation error
 */
router.get(
  '/',
  validateQuery(listMarketsGroup3QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query as unknown as {
        status?: string;
        category?: string;
        search?: string;
        minPool?: number;
        maxPool?: number;
        sort?: string;
        page: number;
        limit: number;
      };

      const page = query.page || 1;
      const limit = query.limit || 20;
      const offset = (page - 1) * limit;

      const whereClauses: string[] = [];
      const values: unknown[] = [];

      if (query.status) {
        values.push(query.status);
        whereClauses.push(`status = $${values.length}`);
      }

      if (query.search) {
        values.push(`%${query.search}%`);
        whereClauses.push(`(fighter_a ILIKE $${values.length} OR fighter_b ILIKE $${values.length} OR venue ILIKE $${values.length})`);
      }

      if (query.minPool !== undefined) {
        values.push(query.minPool);
        whereClauses.push(`total_pool >= $${values.length}`);
      }

      if (query.maxPool !== undefined) {
        values.push(query.maxPool);
        whereClauses.push(`total_pool <= $${values.length}`);
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      let orderSql = 'ORDER BY created_at DESC';
      if (query.sort === 'created_asc') orderSql = 'ORDER BY created_at ASC';
      if (query.sort === 'pool_desc') orderSql = 'ORDER BY total_pool DESC';
      if (query.sort === 'date_asc') orderSql = 'ORDER BY scheduled_at ASC';
      if (query.sort === 'date_desc') orderSql = 'ORDER BY scheduled_at DESC';

      const countRes = await pool.query(`SELECT COUNT(*) as count FROM markets ${whereSql}`, values);
      const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

      const marketsRes = await pool.query(
        `SELECT * FROM markets ${whereSql} ${orderSql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );

      res.status(200).json({
        success: true,
        data: {
          markets: marketsRes.rows,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/markets/{id}:
 *   get:
 *     summary: Retrieve market details by ID
 *     tags: [Market Group 3]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Market details
 *       404:
 *         description: Market not found
 *       422:
 *         description: Invalid path parameter
 */
router.get(
  '/:id',
  validateParams(getMarketGroup3ParamsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await pool.query('SELECT * FROM markets WHERE market_id = $1', [id]);

      if (result.rows.length === 0) {
        throw AppError.notFound(`Market with id '${id}' not found`);
      }

      res.status(200).json({
        success: true,
        data: result.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/markets:
 *   post:
 *     summary: Create a new market (Admin only)
 *     tags: [Market Group 3]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fighter_a, fighter_b, weight_class, scheduled_at]
 *     responses:
 *       201:
 *         description: Market created successfully
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Request validation error
 */
router.post(
  '/',
  createMarketLimiter,
  requireAdminJwt,
  validateBody(createMarketGroup3BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const marketId = `mkt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const contractAddress = `C${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

      const insertResult = await pool.query(
        `INSERT INTO markets (
          market_id, contract_address, match_id, fighter_a, fighter_b,
          weight_class, title_fight, venue, scheduled_at, fee_bps,
          lock_before_secs, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open')
        RETURNING *`,
        [
          marketId,
          contractAddress,
          `match_${Date.now()}`,
          body.fighter_a,
          body.fighter_b,
          body.weight_class,
          body.title_fight,
          body.venue,
          body.scheduled_at,
          body.fee_bps,
          body.lock_before_secs,
        ]
      );

      res.status(201).json({
        success: true,
        message: 'Market created successfully',
        data: insertResult.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/markets/{id}/lock:
 *   patch:
 *     summary: Manually lock market betting (Admin only)
 *     tags: [Market Group 3]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Market locked successfully
 *       400:
 *         description: Market not in open state
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Market not found
 */
router.patch(
  '/:id/lock',
  requireAdminJwt,
  validateParams(lockMarketGroup3ParamsSchema),
  validateBody(lockMarketGroup3BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const existing = await pool.query('SELECT status FROM markets WHERE market_id = $1', [id]);
      if (existing.rows.length === 0) {
        throw AppError.notFound(`Market with id '${id}' not found`);
      }

      if (existing.rows[0].status !== 'open') {
        throw AppError.badRequest(`Market is already in '${existing.rows[0].status}' status`);
      }

      const updateResult = await pool.query(
        `UPDATE markets SET status = 'locked', updated_at = NOW() WHERE market_id = $1 RETURNING *`,
        [id]
      );

      res.status(200).json({
        success: true,
        message: `Market locked: ${reason}`,
        data: updateResult.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
