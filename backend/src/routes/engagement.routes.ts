// ============================================================
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

export default router;
