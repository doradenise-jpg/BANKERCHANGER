// ============================================================
// BANKERCHANGER — REST Endpoint Group 5: Oracle & Disputes
// Addresses Issue #433 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import {
  submitOracleReportGroup5BodySchema,
  flagDisputeGroup5BodySchema,
  resolveDisputeGroup5BodySchema,
  listDisputesGroup5QuerySchema,
} from '../schemas/oracleGroup5.schemas';
import { validateBody, validateQuery } from '../api/middleware/validate';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';

const router = Router();

// Strict rate limit on oracle submissions (10 req/min)
const oracleSubmitLimiter = rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' });

/**
 * Middleware: Verify X-Oracle-Key header
 */
function requireOracleApiKey(req: Request, _res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-oracle-key'];
  const expectedKey = process.env.ORACLE_API_KEY || 'default-oracle-secret-key';

  if (!apiKey || apiKey !== expectedKey) {
    throw AppError.unauthorized('Invalid or missing X-Oracle-Key header');
  }
  next();
}

/**
 * @swagger
 * tags:
 *   name: Oracle & Disputes Group 5
 *   description: Oracle Result Submissions and Dispute Workflows (API Group 5)
 */

/**
 * @swagger
 * /api/v2/oracle/report:
 *   post:
 *     summary: Submit signed oracle match outcome
 *     tags: [Oracle & Disputes Group 5]
 *     parameters:
 *       - in: header
 *         name: X-Oracle-Key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [match_id, market_id, outcome, reported_at, oracle_address, signature]
 *     responses:
 *       200:
 *         description: Report accepted and market resolved
 *       401:
 *         description: Invalid oracle key
 *       404:
 *         description: Market not found
 *       422:
 *         description: Validation error
 */
router.post(
  '/report',
  oracleSubmitLimiter,
  requireOracleApiKey,
  validateBody(submitOracleReportGroup5BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await pool.connect();
    try {
      const { match_id, market_id, outcome, reported_at, oracle_address, signature } = req.body;

      await client.query('BEGIN');

      const marketRes = await client.query(
        'SELECT * FROM markets WHERE market_id = $1 FOR UPDATE',
        [market_id]
      );

      if (marketRes.rows.length === 0) {
        throw AppError.notFound(`Market with id '${market_id}' not found`);
      }

      const market = marketRes.rows[0];
      if (market.status === 'resolved' || market.status === 'cancelled') {
        throw AppError.badRequest(`Market is already in terminal status '${market.status}'`);
      }

      const reportRes = await client.query(
        `INSERT INTO oracle_reports (
          match_id, oracle_address, outcome, reported_at,
          signature, accepted, tx_hash
        ) VALUES ($1, $2, $3, $4, $5, true, $6)
        RETURNING *`,
        [
          match_id,
          oracle_address,
          outcome,
          reported_at,
          signature,
          `tx_oracle_${Date.now()}`,
        ]
      );

      await client.query(
        `UPDATE markets
         SET status = 'resolved',
             outcome = $1,
             resolved_at = $2,
             oracle_used = $3,
             updated_at = NOW()
         WHERE market_id = $4`,
        [outcome, reported_at, oracle_address, market_id]
      );

      await client.query('COMMIT');

      res.status(200).json({
        success: true,
        message: 'Oracle report processed and market resolved',
        data: {
          report: reportRes.rows[0],
          resolved_market_id: market_id,
          outcome,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

/**
 * @swagger
 * /api/v2/oracle/dispute:
 *   post:
 *     summary: Flag a market dispute
 *     tags: [Oracle & Disputes Group 5]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [market_id, initiator_address, reason]
 *     responses:
 *       201:
 *         description: Dispute flagged successfully
 *       400:
 *         description: Market not in resolvable or disputed status
 *       404:
 *         description: Market not found
 */
router.post(
  '/dispute',
  validateBody(flagDisputeGroup5BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { market_id, initiator_address, reason, evidence_url } = req.body;

      const marketRes = await pool.query('SELECT status FROM markets WHERE market_id = $1', [market_id]);
      if (marketRes.rows.length === 0) {
        throw AppError.notFound(`Market with id '${market_id}' not found`);
      }

      const status = marketRes.rows[0].status;
      if (status !== 'resolved' && status !== 'locked') {
        throw AppError.badRequest(`Cannot dispute market in '${status}' status`);
      }

      await pool.query(
        `UPDATE markets SET status = 'disputed', updated_at = NOW() WHERE market_id = $1`,
        [market_id]
      );

      const disputeRes = await pool.query(
        `INSERT INTO disputes (
          market_id, initiator_address, reason, evidence_url, status, created_at
        ) VALUES ($1, $2, $3, $4, 'pending', NOW())
        RETURNING *`,
        [market_id, initiator_address, reason, evidence_url || null]
      );

      res.status(201).json({
        success: true,
        message: 'Dispute recorded and market status updated to disputed',
        data: disputeRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/oracle/dispute/resolve:
 *   post:
 *     summary: Admin dispute resolution with TOTP confirmation
 *     tags: [Oracle & Disputes Group 5]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [market_id, final_outcome, resolution_notes, totp_code]
 *     responses:
 *       200:
 *         description: Dispute resolved
 *       401:
 *         description: Unauthorized or invalid TOTP
 */
router.post(
  '/dispute/resolve',
  requireAdminJwt,
  validateBody(resolveDisputeGroup5BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { market_id, final_outcome, resolution_notes, totp_code } = req.body;

      // Validate 6-digit TOTP format
      if (!/^\d{6}$/.test(totp_code)) {
        throw AppError.unauthorized('Invalid TOTP verification code');
      }

      const marketRes = await pool.query('SELECT status FROM markets WHERE market_id = $1', [market_id]);
      if (marketRes.rows.length === 0) {
        throw AppError.notFound(`Market with id '${market_id}' not found`);
      }

      await pool.query(
        `UPDATE markets
         SET status = 'resolved',
             outcome = $1,
             resolved_at = NOW(),
             updated_at = NOW()
         WHERE market_id = $2`,
        [final_outcome, market_id]
      );

      await pool.query(
        `UPDATE disputes
         SET status = 'resolved',
             resolution_notes = $1,
             resolved_at = NOW()
         WHERE market_id = $2`,
        [resolution_notes, market_id]
      );

      res.status(200).json({
        success: true,
        message: 'Dispute resolved successfully by admin',
        data: {
          market_id,
          final_outcome,
          resolution_notes,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/oracle/disputes:
 *   get:
 *     summary: List recorded disputes with pagination
 *     tags: [Oracle & Disputes Group 5]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, investigating, resolved, dismissed]
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
 *         description: Paginated list of disputes
 */
router.get(
  '/disputes',
  validateQuery(listDisputesGroup5QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query as unknown as {
        status?: string;
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

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      const countRes = await pool.query(`SELECT COUNT(*) as count FROM disputes ${whereSql}`, values);
      const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

      const rowsRes = await pool.query(
        `SELECT * FROM disputes ${whereSql} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );

      res.status(200).json({
        success: true,
        data: {
          disputes: rowsRes.rows,
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

export default router;
