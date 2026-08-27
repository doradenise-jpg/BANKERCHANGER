import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import {
  listMarketsQuery,
  marketIdParam,
  escrowHoldBody,
  closeMarketBody,
  settleEscrowBody,
} from '../schemas/apiModuleGroups.schemas';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: MarketManagement
 *   description: Market listing and escrow settlement controls
 */

/**
 * @swagger
 * /api/v1/market-management/markets:
 *   get:
 *     summary: List markets with filtering
 *     tags: [MarketManagement]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: sport
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [open, locked, resolved, cancelled]
 *       - in: query
 *         name: marketType
 *         schema:
 *           type: string
 *           enum: [moneyline, spread, total, parlay]
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
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Paginated market list
 *       422:
 *         description: Validation error
 */
router.get(
  '/markets',
  requireAuth,
  validate(listMarketsQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query as unknown as {
        sport?: string;
        status?: string;
        marketType?: string;
        page: number;
        limit: number;
      };

      // Placeholder: In production, query the markets table
      const markets = [
        {
          id: '11111111-0000-4000-8000-000000000001',
          sport: query.sport || 'boxing',
          marketType: query.marketType || 'moneyline',
          status: query.status || 'open',
          title: 'Ortiz vs. Patterson',
          escrowStatus: 'held',
          totalVolume: '45_000_000',
          createdAt: new Date().toISOString(),
        },
      ];

      res.json({
        data: markets,
        pagination: {
          page: query.page,
          limit: query.limit,
          total: markets.length,
          totalPages: 1,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/market-management/markets/{marketId}:
 *   get:
 *     summary: Get a single market with escrow details
 *     tags: [MarketManagement]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: marketId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Market detail
 *       422:
 *         description: Validation error
 */
router.get(
  '/markets/:marketId',
  requireAuth,
  validate(marketIdParam, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { marketId } = req.params;

      // Placeholder: In production, load market by id with escrow ledger rows
      res.json({
        id: marketId,
        title: 'Ortiz vs. Patterson',
        sport: 'boxing',
        marketType: 'moneyline',
        status: 'open',
        escrow: {
          totalHeldUsd: '10_000_000',
          pendingSettlementUsd: '0',
          lastHoldRef: 'ESC-2026-0001',
        },
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/market-management/escrow/hold:
 *   post:
 *     summary: Hold funds in escrow for a market (admin)
 *     tags: [MarketManagement]
 *     security:
 *       - adminJwt: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [marketId, amountUsd, holdRef]
 *             properties:
 *               marketId:
 *                 type: string
 *                 format: uuid
 *               amountUsd:
 *                 type: number
 *                 format: double
 *                 exclusiveMinimum: 0
 *               holdRef:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       202:
 *         description: Escrow hold initiated
 *       422:
 *         description: Validation error
 *       429:
 *         description: Rate limit exceeded
 */
router.post(
  '/escrow/hold',
  requireAuth,
  requireAdminJwt,
  rateLimit({ windowMs: 60_000, max: 20, keyBy: 'userId' }),
  validate(escrowHoldBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        marketId: string;
        amountUsd: number;
        holdRef: string;
      };

      // Placeholder: In production, create an escrow ledger hold transaction
      res.status(202).json({
        holdId: 'esc_' + Date.now(),
        marketId: body.marketId,
        amountUsd: body.amountUsd,
        holdRef: body.holdRef,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/market-management/markets/{marketId}/close:
 *   post:
 *     summary: Close a market early (admin)
 *     tags: [MarketManagement]
 *     security:
 *       - adminJwt: []
 *     parameters:
 *       - in: path
 *         name: marketId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *                 enum: [no_contest, rule_change, regulatory, insufficient_liquidity, technical_error, fraud]
 *               cancelBets:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       202:
 *         description: Market close scheduled
 *       422:
 *         description: Validation error
 *       429:
 *         description: Rate limit exceeded
 */
router.post(
  '/markets/:marketId/close',
  requireAuth,
  requireAdminJwt,
  validate(marketIdParam, 'params'),
  rateLimit({ windowMs: 60_000, max: 20, keyBy: 'userId' }),
  validate(closeMarketBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { marketId } = req.params;
      const body = req.body as { reason: string; cancelBets: boolean };

      // Placeholder: In production, enqueue market close + bet cancellation job
      res.status(202).json({
        marketId,
        reason: body.reason,
        cancelBets: body.cancelBets,
        status: 'close_scheduled',
        scheduledAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/market-management/markets/{marketId}/settle:
 *   post:
 *     summary: Settle escrow funds for a resolved market (admin)
 *     tags: [MarketManagement]
 *     security:
 *       - adminJwt: []
 *     parameters:
 *       - in: path
 *         name: marketId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [settleAmountUsd, recipient]
 *             properties:
 *               settleAmountUsd:
 *                 type: number
 *                 format: double
 *                 minimum: 0
 *               recipient:
 *                 type: string
 *               note:
 *                 type: string
 *     responses:
 *       202:
 *         description: Escrow settlement scheduled
 *       422:
 *         description: Validation error
 *       429:
 *         description: Rate limit exceeded
 */
router.post(
  '/markets/:marketId/settle',
  requireAuth,
  requireAdminJwt,
  validate(marketIdParam, 'params'),
  rateLimit({ windowMs: 60_000, max: 20, keyBy: 'userId' }),
  validate(settleEscrowBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { marketId } = req.params;
      const body = req.body as { settleAmountUsd: number; recipient: string };

      // Placeholder: In production, enqueue escrow release to recipient address
      res.status(202).json({
        settlementId: 'stl_' + Date.now(),
        marketId,
        settleAmountUsd: body.settleAmountUsd,
        recipient: body.recipient,
        status: 'settlement_scheduled',
        scheduledAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;