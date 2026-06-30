import { Router } from 'express';
import { claimWinnings, claimRefund, getBetsByAddress, getBettorStats } from '../api/controllers/BetController';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Bets
 *   description: Bet claims and bettor history
 */

/**
 * @swagger
 * /claims:
 *   post:
 *     summary: Claim winnings for a resolved market
 *     tags: [Bets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [marketId, bettorAddress]
 *             properties:
 *               marketId:
 *                 type: string
 *               bettorAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: Winnings claimed
 *       400:
 *         description: No winnings to claim
 */
router.post('/', claimWinnings);

/**
 * @swagger
 * /claims/refund:
 *   post:
 *     summary: Claim a refund for a cancelled market
 *     tags: [Bets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [marketId, bettorAddress]
 *             properties:
 *               marketId:
 *                 type: string
 *               bettorAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: Refund processed
 *       400:
 *         description: Market not cancelled or no bet found
 */
router.post('/refund', claimRefund);

/**
 * @swagger
 * /bets/{bettor_address}/stats:
 *   get:
 *     summary: Get betting statistics for an address
 *     tags: [Bets]
 *     parameters:
 *       - in: path
 *         name: bettor_address
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Bettor statistics
 */
router.get('/:bettor_address/stats', getBettorStats);

/**
 * @swagger
 * /bets/{bettor_address}:
 *   get:
 *     summary: Get paginated bets for an address
 *     tags: [Bets]
 *     parameters:
 *       - in: path
 *         name: bettor_address
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
 *           default: 50
 *           maximum: 200
 *     responses:
 *       200:
 *         description: Paginated list of bets with total count
 */
router.get('/:bettor_address', getBetsByAddress);

export default router;
