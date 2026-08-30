import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import {
  listWalletsQuery,
  walletIdParam,
  walletTransactionsQuery,
  depositBody,
  withdrawBody,
} from '../schemas/apiModuleGroups.schemas';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Wallets
 *   description: Wallet management, deposits and withdrawals
 */

/**
 * @swagger
 * /api/v1/wallets:
 *   get:
 *     summary: List the authenticated user's wallets
 *     tags: [Wallets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: currency
 *         schema:
 *           type: string
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
 *         description: Paginated wallet list
 *       422:
 *         description: Validation error
 */
router.get(
  '/',
  requireAuth,
  validate(listWalletsQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, string>).userId;
      const query = req.query as unknown as {
        currency?: string;
        page: number;
        limit: number;
      };

      // Placeholder: In production, query the wallets table for `userId`
      const wallets = [
        {
          id: 'a1b2c3d4-0000-4000-8000-000000000001',
          userId,
          currency: query.currency || 'USD',
          balance: '1_250_000',
          status: 'active',
          createdAt: new Date().toISOString(),
        },
      ];

      res.json({
        data: wallets,
        pagination: {
          page: query.page,
          limit: query.limit,
          total: wallets.length,
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
 * /api/v1/wallets/{walletId}:
 *   get:
 *     summary: Get a single wallet with its balances
 *     tags: [Wallets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: walletId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Wallet detail
 *       403:
 *         description: Wallet does not belong to the authenticated user
 *       422:
 *         description: Validation error
 */
router.get(
  '/:walletId',
  requireAuth,
  validate(walletIdParam, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { walletId } = req.params;
      const userId = (req as unknown as Record<string, string>).userId;

      // Placeholder: In production, load wallet by id and verify ownership
      res.json({
        id: walletId,
        userId,
        currency: 'USD',
        balance: '1_250_000',
        available: '1_000_000',
        escrowed: '250_000',
        frozen: '0',
        status: 'active',
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/wallets/{walletId}/transactions:
 *   get:
 *     summary: Get a wallet's transaction history
 *     tags: [Wallets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: walletId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [deposit, withdrawal, bet, claim, refund]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, completed, failed, cancelled]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *     responses:
 *       200:
 *         description: Paginated transaction list
 *       422:
 *         description: Validation error
 */
router.get(
  '/:walletId/transactions',
  requireAuth,
  validate(walletIdParam, 'params'),
  validate(walletTransactionsQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query as unknown as {
        type?: string;
        status?: string;
        page: number;
        limit: number;
      };

      const transactions = [
        {
          id: 't1',
          walletId: req.params.walletId,
          type: query.type || 'deposit',
          status: query.status || 'completed',
          amount: '100_000',
          currency: 'USD',
          createdAt: new Date().toISOString(),
        },
      ];

      res.json({
        data: transactions,
        pagination: {
          page: query.page,
          limit: query.limit,
          total: transactions.length,
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
 * /api/v1/wallets/deposit:
 *   post:
 *     summary: Initiate a wallet deposit
 *     tags: [Wallets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [walletId, currency, amount, paymentMethod]
 *             properties:
 *               walletId:
 *                 type: string
 *                 format: uuid
 *               currency:
 *                 type: string
 *               amount:
 *                 type: number
 *                 format: double
 *                 exclusiveMinimum: 0
 *               paymentMethod:
 *                 type: string
 *                 enum: [card, bank_transfer, crypto, stellar]
 *               referenceId:
 *                 type: string
 *     responses:
 *       202:
 *         description: Deposit initiated
 *       422:
 *         description: Validation error
 */
router.post(
  '/deposit',
  requireAuth,
  validate(depositBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        walletId: string;
        currency: string;
        amount: number;
        paymentMethod: string;
      };

      // Placeholder: In production, enqueue a deposit job and track its status
      res.status(202).json({
        depositId: 'dep_' + Date.now(),
        walletId: body.walletId,
        amount: body.amount,
        currency: body.currency,
        paymentMethod: body.paymentMethod,
        status: 'processing',
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/wallets/withdraw:
 *   post:
 *     summary: Initiate a wallet withdrawal
 *     tags: [Wallets]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [walletId, currency, amount, destination]
 *             properties:
 *               walletId:
 *                 type: string
 *                 format: uuid
 *               currency:
 *                 type: string
 *               amount:
 *                 type: number
 *                 format: double
 *                 exclusiveMinimum: 0
 *               destination:
 *                 type: string
 *               note:
 *                 type: string
 *     responses:
 *       202:
 *         description: Withdrawal initiated
 *       422:
 *         description: Validation error
 *       429:
 *         description: Withdrawal rate limit exceeded
 */
router.post(
  '/withdraw',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 5, keyBy: 'userId' }),
  validate(withdrawBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        walletId: string;
        currency: string;
        amount: number;
        destination: string;
      };

      // Placeholder: In production, run KYC/balance checks and enqueue the withdrawal
      res.status(202).json({
        withdrawalId: 'wd_' + Date.now(),
        walletId: body.walletId,
        amount: body.amount,
        currency: body.currency,
        destination: body.destination,
        status: 'pending_review',
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;