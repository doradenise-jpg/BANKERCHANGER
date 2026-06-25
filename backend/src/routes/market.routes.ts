import { Router } from 'express';
import {
    listMarkets,
    listMarketsValidation,
    getMarket,
    getMarketBets,
    getMarketBetsValidation,
    getMarketOdds,
    getMarketStats,
    getPlatformStats,
    resolveMarket,
    simulatePayout,
    simulatePayoutValidation,
} from '../api/controllers/MarketController';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Markets
 *   description: Prediction market endpoints
 */

/**
 * @swagger
 * /markets:
 *   get:
 *     summary: List all markets (paginated)
 *     tags: [Markets]
 *     parameters:
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
 *           maximum: 200
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [OPEN, LOCKED, RESOLVED, CANCELLED]
 *     responses:
 *       200:
 *         description: Paginated list of markets
 *       400:
 *         description: Invalid parameters (limit exceeds maximum of 200)
 */
router.get('/', listMarketsValidation, listMarkets);

/**
 * @swagger
 * /markets/{market_id}:
 *   get:
 *     summary: Get a single market by ID
 *     tags: [Markets]
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Market details
 *       404:
 *         description: Market not found
 */
router.get('/:market_id', getMarket);

/**
 * @swagger
 * /markets/{market_id}/bets:
 *   get:
 *     summary: List bets for a market
 *     tags: [Markets]
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
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
 *     responses:
 *       200:
 *         description: Paginated list of bets
 */
router.get('/:market_id/bets', getMarketBetsValidation, getMarketBets);

/**
 * @swagger
 * /markets/{market_id}/odds:
 *   get:
 *     summary: Get current odds for a market
 *     tags: [Markets]
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Current odds
 */
router.get('/:market_id/odds', getMarketOdds);

/**
 * @swagger
 * /markets/{market_id}/stats:
 *   get:
 *     summary: Get statistics for a market
 *     tags: [Markets]
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Market statistics
 */
router.get('/:market_id/stats', getMarketStats);

/**
 * @swagger
 * /markets/{market_id}/simulate:
 *   get:
 *     summary: Simulate payout for a given bet amount and outcome
 *     tags: [Markets]
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: amount
 *         required: true
 *         schema:
 *           type: number
 *       - in: query
 *         name: outcome
 *         required: true
 *         schema:
 *           type: integer
 *           enum: [0, 1]
 *     responses:
 *       200:
 *         description: Simulated payout details
 */
router.get('/:market_id/simulate', simulatePayoutValidation, simulatePayout);

/**
 * @swagger
 * /markets/{market_id}/resolve:
 *   post:
 *     summary: Resolve a market (admin only)
 *     tags: [Markets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: market_id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [winningOutcome]
 *             properties:
 *               winningOutcome:
 *                 type: integer
 *                 enum: [0, 1]
 *     responses:
 *       200:
 *         description: Market resolved
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Market not found
 */
router.post('/:market_id/resolve', requireAdminJwt, resolveMarket);

export default router;
