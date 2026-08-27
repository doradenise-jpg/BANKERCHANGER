// backend/src/routes/engagement.routes.ts - Engagement Routes
// Gamification & notifications: streaks, badges, referrals, leaderboard.
import { Router } from 'express';
import { engagementController } from '../api/controllers/EngagementController.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

/**
 * @swagger
 * /api/engagement/me:
 *   get:
 *     summary: Get current user's engagement profile (streaks, badges, referrals)
 *     tags: [Engagement]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Engagement profile
 *       401:
 *         description: Unauthorized
 */
router.get('/me', requireAuth, engagementController.getMyEngagement.bind(engagementController));

/**
 * @swagger
 * /api/engagement/leaderboard:
 *   get:
 *     summary: Get the global engagement leaderboard
 *     tags: [Engagement]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Leaderboard
 *       401:
 *         description: Unauthorized
 */
router.get('/leaderboard', requireAuth, engagementController.getLeaderboard.bind(engagementController));

/**
 * @swagger
 * /api/engagement/referrals:
 *   post:
 *     summary: Record a referral edge for the current user
 *     tags: [Engagement]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               referredId:
 *                 type: string
 *     responses:
 *       201:
 *         description: Referral recorded
 *       400:
 *         description: Invalid request
 *       409:
 *         description: Referral already exists
 */
router.post('/referrals', requireAuth, engagementController.createReferral.bind(engagementController));

/**
 * @swagger
 * /api/engagement/referrals/payouts:
 *   get:
 *     summary: Compute and persist referral payouts for the current user
 *     tags: [Engagement]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Computed payouts
 */
router.get('/referrals/payouts', requireAuth, engagementController.getReferralPayouts.bind(engagementController));

export default router;
