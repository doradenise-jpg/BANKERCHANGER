// backend/src/routes/engagement.routes.ts - Engagement Routes
// Gamification & notifications: streaks, badges, referrals, leaderboard.
import { Router } from 'express';
import { engagementController } from '../api/controllers/EngagementController.js';
import { requireAuth } from '../middleware/auth.middleware.js';

import { Router } from 'express';
import {
    getStreak,
    getStreakValidation,
    recordPrediction,
    recordPredictionValidation,
    listAchievements,
    getUserAchievements,
    getUserAchievementsValidation,
    registerReferral,
    registerReferralValidation,
    getReferralSummary,
    getReferralSummaryValidation,
    calculateReferralPayout,
    calculatePayoutValidation,
    recordReferralPayout,
    recordPayoutValidation,
    getLeaderboard,
    getLeaderboardValidation,
    getNotifications,
    getNotificationsValidation,
    markNotificationRead,
    markReadValidation,
} from '../api/controllers/EngagementController';

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

// =====================================================
// BANKERCHANGER — Engagement / Gamification Routes
// Mounted at /api/engagement
//
//   Streaks & badges
//     POST /predictions/result   (auth)  record a settled prediction
//     GET  /streak               (auth)  caller's streak state
//     GET  /badges               (auth)  caller's earned badges
//     GET  /badges/:userId               public badge list for a user
//
//   Referrals
//     POST /referrals            (auth)  link a referee under the caller
//     GET  /referrals/tree       (auth)  caller's downline tree
//     POST /referrals/fee        (auth)  record downline platform fees
//     GET  /referrals/payouts    (auth)  computed payouts + earnings
//
//   Leaderboard
//     GET  /leaderboard                  public top-N ranking
//     POST /leaderboard/points   (auth)  add points, triggers WS rank updates
//     GET  /leaderboard/rank     (auth)  caller's current rank
// ============================================================

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware';
import { AppError } from '../utils/AppError';
import { engagementService } from '../services/engagement.service';

const router = Router();

function callerId(req: Request): string {
  const userId = (req as unknown as Record<string, unknown>).userId;
  if (typeof userId !== 'string' || !userId) {
    throw new AppError(401, 'Authentication required');
  }
  return userId;
}

function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(400, 'Validation failed', 'VALIDATION_ERROR', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Streaks & badges
// ---------------------------------------------------------------------------

const predictionResultBody = z.object({ won: z.boolean() });

/**
 * @swagger
 * /api/engagement/predictions/result:
 *   post:
 *     summary: Record the outcome of a settled prediction for the caller
 *     tags: [Engagement]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/predictions/result',
  requireAuth,
  handle((req, res) => {
    const { won } = parse(predictionResultBody, req.body);
    const result = engagementService.recordPredictionResult(callerId(req), won);
    res.json({ success: true, data: result });
  }),
);

/**
 * @swagger
 * /api/engagement/streak:
 *   get:
 *     summary: Get the caller's prediction streak state
 *     tags: [Engagement]
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  '/streak',
  requireAuth,
  handle((req, res) => {
    res.json({ success: true, data: engagementService.getStreak(callerId(req)) });
  }),
);

/**
 * @swagger
 * /api/engagement/badges:
 *   get:
 *     summary: Get the caller's earned achievement badges
 *     tags: [Engagement]
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  '/badges',
  requireAuth,
  handle((req, res) => {
    res.json({ success: true, data: engagementService.getBadges(callerId(req)) });
  }),
);

/**
 * @swagger
 * /api/engagement/badges/{userId}:
 *   get:
 *     summary: Get the public badge list for any user
 *     tags: [Engagement]
 */
router.get(
  '/badges/:userId',
  handle((req, res) => {
    res.json({ success: true, data: engagementService.getBadges(req.params.userId) });
  }),
);

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

const registerReferralBody = z.object({ refereeUserId: z.string().min(1) });
const referralFeeBody = z.object({
  refereeUserId: z.string().min(1),
  feeAmount: z.number().positive(),
});

/**
 * @swagger
 * /api/engagement/referrals:
 *   post:
 *     summary: Record a referral edge for the current user
 *     tags: [Engagement]
 *     security:
 *       - bearerAuth: []
 * tags:
 *   name: Engagement
 *   description: User engagement endpoints (streaks, achievements, referrals, leaderboard)
 */

/**
 * @swagger
 * /engagement/streak/{address}:
 *   get:
 *     summary: Get a user's prediction streak
 *     tags: [Engagement]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User streak
 *       422:
 *         description: Invalid Stellar address
 */
router.get('/streak/:address', getStreakValidation, getStreak);

/**
 * @swagger
 * /engagement/predictions:
 *   post:
 *     summary: Record a prediction (advances streak, awards badges)
 *     tags: [Engagement]
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

 *     summary: Link a referee under the authenticated referrer
 *     tags: [Engagement]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/referrals',
  requireAuth,
  handle((req, res) => {
    const { refereeUserId } = parse(registerReferralBody, req.body);
    engagementService.registerReferral(callerId(req), refereeUserId);
    res.status(201).json({
      success: true,
      data: { referrals: engagementService.getDirectReferrals(callerId(req)) },
    });
  }),
);

/**
 * @swagger
 * /api/engagement/referrals/tree:
 *   get:
 *     summary: Get the caller's multi-level referral tree
 *     tags: [Engagement]
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  '/referrals/tree',
  requireAuth,
  handle((req, res) => {
    res.json({ success: true, data: engagementService.getReferralTree(callerId(req)) });
  }),
);

/**
 * @swagger
 * /api/engagement/referrals/fee:
 *   post:
 *     summary: Record platform fees generated by a downline user
 *     tags: [Engagement]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/referrals/fee',
  requireAuth,
  handle((req, res) => {
    const { refereeUserId, feeAmount } = parse(referralFeeBody, req.body);
    const payouts = engagementService.recordReferralFee(refereeUserId, feeAmount);
    res.json({ success: true, data: { payouts } });
  }),
);

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

 *     summary: Get the caller's computed referral payouts and total earnings
 *     tags: [Engagement]
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  '/referrals/payouts',
  requireAuth,
  handle((req, res) => {
    const userId = callerId(req);
    res.json({
      success: true,
      data: {
        payouts: engagementService.computeReferralPayouts(userId),
        totalEarnings: engagementService.getReferralEarnings(userId),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

const addPointsBody = z.object({ points: z.number().positive() });

/**
 * @swagger
 * /api/engagement/leaderboard:
 *   get:
 *     summary: Get the top-N leaderboard

 *             required: [address]
 *             properties:
 *               address:
 *                 type: string
 *     responses:
 *       200:
 *         description: Updated streak and newly earned achievements
 *       422:
 *         description: Invalid request body
 */
router.post('/predictions', recordPredictionValidation, recordPrediction);

/**
 * @swagger
 * /engagement/achievements:
 *   get:
 *     summary: List the achievement badge catalogue
 *     tags: [Engagement]
 *     responses:
 *       200:
 *         description: List of achievements
 */
router.get('/achievements', listAchievements);

/**
 * @swagger
 * /engagement/achievements/{address}:
 *   get:
 *     summary: Get a user's earned achievements
 *     tags: [Engagement]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Earned achievements
 *       422:
 *         description: Invalid Stellar address
 */
router.get('/achievements/:address', getUserAchievementsValidation, getUserAchievements);

/**
 * @swagger
 * /engagement/referrals:
 *   post:
 *     summary: Register a referral link
 *     tags: [Engagement]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [referrer_address, referred_address, referral_code]
 *             properties:
 *               referrer_address:
 *                 type: string
 *               referred_address:
 *                 type: string
 *               referral_code:
 *                 type: string
 *     responses:
 *       201:
 *         description: Referral registered
 *       409:
 *         description: Address already has a referrer
 *       422:
 *         description: Invalid request body
 */
router.post('/referrals', registerReferralValidation, registerReferral);

/**
 * @swagger
 * /engagement/referrals/payout:
 *   post:
 *     summary: Calculate expected referral payouts for an amount
 *     tags: [Engagement]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address, amount]
 *             properties:
 *               address:
 *                 type: string
 *               amount:
 *                 type: number
 *     responses:
 *       200:
 *         description: Calculated payout breakdown
 *       422:
 *         description: Invalid request body
 */
router.post('/referrals/payout', calculatePayoutValidation, calculateReferralPayout);

/**
 * @swagger
 * /engagement/referrals/payouts/record:
 *   post:
 *     summary: Record calculated referral payouts for a transaction
 *     tags: [Engagement]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [referrer_address, referred_address, amount]
 *             properties:
 *               referrer_address:
 *                 type: string
 *               referred_address:
 *                 type: string
 *               amount:
 *                 type: number
 *     responses:
 *       201:
 *         description: Payouts recorded
 *       422:
 *         description: Invalid request body
 */
router.post('/referrals/payouts/record', recordPayoutValidation, recordReferralPayout);

/**
 * @swagger
 * /engagement/referrals/{address}:
 *   get:
 *     summary: Get a referral summary for an address
 *     tags: [Engagement]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Referral summary
 *       422:
 *         description: Invalid Stellar address
 */
router.get('/referrals/:address', getReferralSummaryValidation, getReferralSummary);

/**
 * @swagger
 * /engagement/leaderboard:
 *   get:
 *     summary: Get the global engagement leaderboard
 *     tags: [Engagement]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100, maximum: 500 }
 */
router.get(
  '/leaderboard',
  handle((req, res) => {
    const raw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(1, Math.trunc(raw)), 500) : 100;
    res.json({ success: true, data: engagementService.getLeaderboard(limit) });
  }),
);

/**
 * @swagger
 * /api/engagement/leaderboard/points:
 *   post:
 *     summary: Add leaderboard points for the caller (emits real-time rank updates)
 *     tags: [Engagement]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/leaderboard/points',
  requireAuth,
  handle((req, res) => {
    const { points } = parse(addPointsBody, req.body);
    const updates = engagementService.addPoints(callerId(req), points);
    res.json({
      success: true,
      data: { rank: engagementService.getRank(callerId(req)), updates },
    });
  }),
);

/**
 * @swagger
 * /api/engagement/leaderboard/rank:
 *   get:
 *     summary: Get the caller's current leaderboard rank
 *     tags: [Engagement]
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  '/leaderboard/rank',
  requireAuth,
  handle((req, res) => {
    res.json({ success: true, data: { rank: engagementService.getRank(callerId(req)) } });
  }),
);

 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *     responses:
 *       200:
 *         description: Leaderboard entries
 */
router.get('/leaderboard', getLeaderboardValidation, getLeaderboard);

/**
 * @swagger
 * /engagement/notifications/{address}:
 *   get:
 *     summary: Get a user's notifications
 *     tags: [Engagement]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *     responses:
 *       200:
 *         description: User notifications
 *       422:
 *         description: Invalid Stellar address
 */
router.get('/notifications/:address', getNotificationsValidation, getNotifications);

/**
 * @swagger
 * /engagement/notifications/{address}/{id}/read:
 *   post:
 *     summary: Mark a notification as read
 *     tags: [Engagement]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Notification marked read
 *       404:
 *         description: Notification not found
 */
router.post('/notifications/:address/:id/read', markReadValidation, markNotificationRead);

export default router;
