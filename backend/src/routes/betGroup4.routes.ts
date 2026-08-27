// ============================================================
// BANKERCHANGER — REST Endpoint Group 4: Betting & Slippage Guard
// Addresses Issue #432 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import {
  placeBetGroup4BodySchema,
  getUserBetsGroup4ParamsSchema,
  getUserBetsGroup4QuerySchema,
  calculatePayoutGroup4BodySchema,
  batchPayoutGroup4BodySchema,
} from '../schemas/betGroup4.schemas';
import { validateBody, validateParams, validateQuery } from '../api/middleware/validate';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';

const router = Router();

// Per-user/IP rate limiter for placing bets (30 requests per minute)
const betPlacementLimiter = rateLimit({ windowMs: 60_000, max: 30, keyBy: 'ip' });

/**
 * @swagger
 * tags:
 *   name: Betting Group 4
 *   description: Betting Operations, Slippage Guard, and Projected Payouts (API Group 4)
 */

/**
 * @swagger
 * /api/v2/bets/place:
 *   post:
 *     summary: Place a bet with slippage tolerance and validation
 *     tags: [Betting Group 4]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [market_id, bettor_address, side, amount]
 *     responses:
 *       201:
 *         description: Bet placed successfully
 *       400:
 *         description: Market not open or slippage exceeded
 *       404:
 *         description: Market not found
 *       422:
 *         description: Payload validation error
 */
router.post(
  '/place',
  betPlacementLimiter,
  validateBody(placeBetGroup4BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    const client = await pool.connect();
    try {
      const { market_id, bettor_address, side, amount, max_slippage_bps, idempotency_key } = req.body;

      await client.query('BEGIN');

      const marketRes = await client.query(
        'SELECT * FROM markets WHERE market_id = $1 FOR UPDATE',
        [market_id]
      );

      if (marketRes.rows.length === 0) {
        throw AppError.notFound(`Market with id '${market_id}' not found`);
      }

      const market = marketRes.rows[0];
      if (market.status !== 'open') {
        throw AppError.badRequest(`Cannot bet on market with status '${market.status}'`);
      }

      const betAmountBig = BigInt(amount);
      const totalPoolBig = BigInt(market.total_pool ?? '0');
      const sidePoolCol = side === 'fighter_a' ? 'pool_a' : side === 'fighter_b' ? 'pool_b' : 'pool_draw';
      const currentSidePoolBig = BigInt(market[sidePoolCol] ?? '0');

      // Calculate initial odds vs post-bet odds for slippage guard
      if (totalPoolBig > 0n && currentSidePoolBig > 0n) {
        const initialOddsBps = (totalPoolBig * 10000n) / currentSidePoolBig;
        const newTotalPool = totalPoolBig + betAmountBig;
        const newSidePool = currentSidePoolBig + betAmountBig;
        const newOddsBps = (newTotalPool * 10000n) / newSidePool;

        if (initialOddsBps > newOddsBps) {
          const slippageBps = Number(((initialOddsBps - newOddsBps) * 10000n) / initialOddsBps);
          if (max_slippage_bps !== undefined && slippageBps > max_slippage_bps) {
            throw AppError.badRequest(
              `Slippage exceeded: expected max ${max_slippage_bps} bps, calculated ${slippageBps} bps`
            );
          }
        }
      }

      const txHash = idempotency_key ? `tx_${idempotency_key}` : `tx_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      const betInsertRes = await client.query(
        `INSERT INTO bets (
          market_id, bettor_address, side, amount, amount_xlm,
          tx_hash, ledger_sequence, placed_at, claimed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), false)
        RETURNING *`,
        [
          market_id,
          bettor_address,
          side,
          amount,
          Number(amount) / 10_000_000,
          txHash,
          1000,
        ]
      );

      await client.query(
        `UPDATE markets
         SET ${sidePoolCol} = ${sidePoolCol} + $1,
             total_pool = total_pool + $1,
             updated_at = NOW()
         WHERE market_id = $2`,
        [amount, market_id]
      );

      await client.query('COMMIT');

      res.status(201).json({
        success: true,
        message: 'Bet placed successfully',
        data: betInsertRes.rows[0],
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
 * /api/v2/bets/user/{address}:
 *   get:
 *     summary: Retrieve bets placed by a specific Stellar address
 *     tags: [Betting Group 4]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [open, locked, resolved, cancelled]
 *       - in: query
 *         name: claimed
 *         schema:
 *           type: boolean
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
 *         description: Paginated bets
 *       422:
 *         description: Invalid address or query
 */
router.get(
  '/user/:address',
  validateParams(getUserBetsGroup4ParamsSchema),
  validateQuery(getUserBetsGroup4QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const query = req.query as unknown as {
        status?: string;
        claimed?: boolean;
        page: number;
        limit: number;
      };

      const page = query.page || 1;
      const limit = query.limit || 20;
      const offset = (page - 1) * limit;

      const whereClauses: string[] = ['b.bettor_address = $1'];
      const values: unknown[] = [address];

      if (query.status) {
        values.push(query.status);
        whereClauses.push(`m.status = $${values.length}`);
      }

      if (query.claimed !== undefined) {
        values.push(query.claimed);
        whereClauses.push(`b.claimed = $${values.length}`);
      }

      const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

      const countRes = await pool.query(
        `SELECT COUNT(*) as count FROM bets b JOIN markets m ON b.market_id = m.market_id ${whereSql}`,
        values
      );
      const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

      const betsRes = await pool.query(
        `SELECT b.*, m.fighter_a, m.fighter_b, m.status as market_status, m.outcome as market_outcome
         FROM bets b
         JOIN markets m ON b.market_id = m.market_id
         ${whereSql}
         ORDER BY b.placed_at DESC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );

      res.status(200).json({
        success: true,
        data: {
          bets: betsRes.rows,
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
 * /api/v2/bets/calculate-payout:
 *   post:
 *     summary: Simulate projected payout for a potential bet
 *     tags: [Betting Group 4]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [market_id, amount, side]
 *     responses:
 *       200:
 *         description: Projected payout details
 *       404:
 *         description: Market not found
 */
router.post(
  '/calculate-payout',
  validateBody(calculatePayoutGroup4BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { market_id, amount, side } = req.body;
      const marketRes = await pool.query('SELECT * FROM markets WHERE market_id = $1', [market_id]);

      if (marketRes.rows.length === 0) {
        throw AppError.notFound(`Market with id '${market_id}' not found`);
      }

      const market = marketRes.rows[0];
      const feeBps = market.fee_bps ?? 200;
      const betAmountBig = BigInt(amount);
      const totalPoolBig = BigInt(market.total_pool ?? '0');
      const sidePoolCol = side === 'fighter_a' ? 'pool_a' : side === 'fighter_b' ? 'pool_b' : 'pool_draw';
      const sidePoolBig = BigInt(market[sidePoolCol] ?? '0');

      const netTotalPool = totalPoolBig + betAmountBig;
      const netSidePool = sidePoolBig + betAmountBig;
      const feeAmount = (netTotalPool * BigInt(feeBps)) / 10000n;
      const distributablePool = netTotalPool - feeAmount;

      const projectedPayoutBig = (betAmountBig * distributablePool) / netSidePool;
      const multiplier = Number((distributablePool * 10000n) / netSidePool) / 10000;

      res.status(200).json({
        success: true,
        data: {
          market_id,
          bet_amount: amount,
          bet_amount_xlm: Number(amount) / 10_000_000,
          projected_payout: projectedPayoutBig.toString(),
          projected_payout_xlm: Number(projectedPayoutBig) / 10_000_000,
          multiplier,
          fee_bps: feeBps,
          fee_amount: feeAmount.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/bets/batch-payout:
 *   post:
 *     summary: Batch projected payout calculations
 *     tags: [Betting Group 4]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [simulations]
 *     responses:
 *       200:
 *         description: Array of payout calculations
 */
router.post(
  '/batch-payout',
  validateBody(batchPayoutGroup4BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { simulations } = req.body;
      const results = [];

      for (const sim of simulations) {
        const marketRes = await pool.query('SELECT * FROM markets WHERE market_id = $1', [sim.market_id]);
        if (marketRes.rows.length === 0) {
          results.push({ market_id: sim.market_id, error: 'Market not found' });
          continue;
        }

        const market = marketRes.rows[0];
        const feeBps = market.fee_bps ?? 200;
        const betAmountBig = BigInt(sim.amount);
        const totalPoolBig = BigInt(market.total_pool ?? '0');
        const sidePoolCol = sim.side === 'fighter_a' ? 'pool_a' : sim.side === 'fighter_b' ? 'pool_b' : 'pool_draw';
        const sidePoolBig = BigInt(market[sidePoolCol] ?? '0');

        const netTotalPool = totalPoolBig + betAmountBig;
        const netSidePool = sidePoolBig + betAmountBig;
        const feeAmount = (netTotalPool * BigInt(feeBps)) / 10000n;
        const distributablePool = netTotalPool - feeAmount;
        const projectedPayoutBig = (betAmountBig * distributablePool) / netSidePool;

        results.push({
          market_id: sim.market_id,
          side: sim.side,
          amount: sim.amount,
          projected_payout: projectedPayoutBig.toString(),
          projected_payout_xlm: Number(projectedPayoutBig) / 10_000_000,
        });
      }

      res.status(200).json({
        success: true,
        data: results,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
