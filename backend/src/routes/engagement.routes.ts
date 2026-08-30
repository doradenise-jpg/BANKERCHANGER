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
