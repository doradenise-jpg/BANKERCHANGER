import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware';
import { AppError } from '../utils/AppError';
import { engagementService } from '../services/engagement.service';
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
// Streaks & predictions
// ---------------------------------------------------------------------------
const predictionResultBody = z.object({ won: z.boolean() });

router.post(
  '/predictions/result',
  requireAuth,
  handle((req, res) => {
    const { won } = parse(predictionResultBody, req.body);
    const result = engagementService.recordPredictionResult(callerId(req), won);
    res.json({ success: true, data: result });
  }),
);

router.get(
  '/streak',
  requireAuth,
  handle((req, res) => {
    res.json({ success: true, data: engagementService.getStreak(callerId(req)) });
  }),
);

router.get('/streak/:address', getStreakValidation, getStreak);
router.post('/predictions', recordPredictionValidation, recordPrediction);

// ---------------------------------------------------------------------------
// Achievements & badges
// ---------------------------------------------------------------------------
router.get('/achievements', listAchievements);
router.get('/achievements/:address', getUserAchievementsValidation, getUserAchievements);

router.get(
  '/badges',
  requireAuth,
  handle((req, res) => {
    res.json({ success: true, data: engagementService.getBadges(callerId(req)) });
  }),
);

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

router.post(
  '/referrals/link',
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

router.get(
  '/referrals/tree',
  requireAuth,
  handle((req, res) => {
    res.json({ success: true, data: engagementService.getReferralTree(callerId(req)) });
  }),
);

router.post(
  '/referrals/fee',
  requireAuth,
  handle((req, res) => {
    const { refereeUserId, feeAmount } = parse(referralFeeBody, req.body);
    const payouts = engagementService.recordReferralFee(refereeUserId, feeAmount);
    res.json({ success: true, data: { payouts } });
  }),
);

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

router.post('/referrals', registerReferralValidation, registerReferral);
router.post('/referrals/payout', calculatePayoutValidation, calculateReferralPayout);
router.post('/referrals/payouts/record', recordPayoutValidation, recordReferralPayout);
router.get('/referrals/:address', getReferralSummaryValidation, getReferralSummary);

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
const addPointsBody = z.object({ points: z.number().positive() });

router.get(
  '/leaderboard',
  getLeaderboardValidation,
  getLeaderboard
);

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

router.get(
  '/leaderboard/rank',
  requireAuth,
  handle((req, res) => {
    res.json({ success: true, data: { rank: engagementService.getRank(callerId(req)) } });
  }),
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
router.get('/notifications/:address', getNotificationsValidation, getNotifications);
router.post('/notifications/:address/:id/read', markReadValidation, markNotificationRead);

export default router;
