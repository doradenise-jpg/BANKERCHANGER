// ============================================================
// BANKERCHANGER — Engagement Controller
// Handles HTTP requests for user engagement endpoints
// (streaks, achievements, referrals, leaderboard, notifications).
// ============================================================

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';
import { AppError } from '../../utils/AppError';
import { validateQuery, validateBody, validateParams } from '../middleware/validate';
import * as EngagementService from '../../services/engagement.service';

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

const addressParamSchema = z.object({
  address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format',
    }),
});

/**
 * GET /api/engagement/streak/:address
 * Returns a user's current prediction streak and best streak.
 */
export const getStreakValidation = validateParams(addressParamSchema);

export async function getStreak(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { address } = req.params;
    const streak = await EngagementService.getOrInitStreak(address);
    res.status(200).json(streak);
  } catch (err) {
    next(err);
  }
}

const recordPredictionBodySchema = z.object({
  address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format',
    }),
});

/**
 * POST /api/engagement/predictions
 * Records a prediction, advancing/resetting the user's streak, and awards any
 * newly earned achievement badges.
 */
export const recordPredictionValidation = validateBody(recordPredictionBodySchema);

export async function recordPrediction(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { address } = req.body;
    const { streak, earnedAchievements } = await EngagementService.recordPrediction(address);
    await EngagementService.publishLeaderboardRank(address);
    res.status(200).json({ streak, earnedAchievements });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

/**
 * GET /api/engagement/achievements
 * Returns the full achievement badge catalogue.
 */
export async function listAchievements(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const achievements = await EngagementService.listAchievements();
    res.status(200).json(achievements);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/engagement/achievements/:address
 * Returns the badges a user has earned.
 */
export const getUserAchievementsValidation = validateParams(addressParamSchema);

export async function getUserAchievements(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { address } = req.params;
    const achievements = await EngagementService.getUserAchievements(address);
    res.status(200).json(achievements);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

const registerReferralBodySchema = z.object({
  referrer_address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format',
    }),
  referred_address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format',
    }),
  referral_code: z.string().min(3).max(64),
});

/**
 * POST /api/engagement/referrals
 * Registers a referral link between referrer and referred addresses.
 */
export const registerReferralValidation = validateBody(registerReferralBodySchema);

export async function registerReferral(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { referrer_address, referred_address, referral_code } = req.body;
    const referral = await EngagementService.registerReferral(
      referrer_address,
      referred_address,
      referral_code,
    );
    if (!referral) {
      res.status(409).json({ error: 'Address already has a referrer' });
      return;
    }
    res.status(201).json(referral);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/engagement/referrals/:address
 * Returns a referral summary (counts, payouts, tree size) for the address.
 */
export const getReferralSummaryValidation = validateParams(addressParamSchema);

export async function getReferralSummary(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { address } = req.params;
    const summary = await EngagementService.getReferralSummary(address);
    res.status(200).json(summary);
  } catch (err) {
    next(err);
  }
}

const calculatePayoutBodySchema = z.object({
  address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format',
    }),
  amount: z.coerce.number().positive({ message: 'amount must be a positive number' }),
});

/**
 * POST /api/engagement/referrals/payout
 * Calculates expected referral payouts across the referral tree for an amount.
 */
export const calculatePayoutValidation = validateBody(calculatePayoutBodySchema);

export async function calculateReferralPayout(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { address, amount } = req.body;
    const payout = await EngagementService.calculateReferralPayout(address, String(amount));
    res.status(200).json(payout);
  } catch (err) {
    next(err);
  }
}

const recordPayoutBodySchema = z.object({
  referrer_address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format',
    }),
  referred_address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format',
    }),
  amount: z.coerce.number().positive({ message: 'amount must be a positive number' }),
});

/**
 * POST /api/engagement/referrals/payouts/record
 * Records calculated referral payouts for a transaction.
 */
export const recordPayoutValidation = validateBody(recordPayoutBodySchema);

export async function recordReferralPayout(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { referrer_address, referred_address, amount } = req.body;
    const payout = await EngagementService.calculateReferralPayout(
      referrer_address,
      String(amount),
    );
    await EngagementService.recordReferralPayouts(
      referrer_address,
      referred_address,
      String(amount),
      payout,
    );
    res.status(201).json({ recorded: true, payout });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/engagement/leaderboard
 * Returns the global engagement leaderboard.
 */
export const getLeaderboardValidation = validateQuery(leaderboardQuerySchema);

export async function getLeaderboard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { limit } = req.query as unknown as { limit: number };
    const leaderboard = await EngagementService.getLeaderboard(limit);
    res.status(200).json(leaderboard);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const notificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/engagement/notifications/:address
 * Returns the user's in-app notifications.
 */
export const getNotificationsValidation = validateQuery(notificationsQuerySchema);

export async function getNotifications(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { address } = req.params;
    const { limit } = req.query as unknown as { limit: number };
    const notifications = await EngagementService.getUserNotifications(address, limit);
    res.status(200).json(notifications);
  } catch (err) {
    next(err);
  }
}

const markReadParamsSchema = z.object({
  address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format',
    }),
  id: z.coerce.number().int().positive(),
});

/**
 * POST /api/engagement/notifications/:address/:id/read
 * Marks a single notification as read.
 */
export const markReadValidation = validateParams(markReadParamsSchema);

export async function markNotificationRead(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { address, id } = req.params as unknown as { address: string; id: number };
    const result = await EngagementService.markNotificationRead(address, id);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      return next(err);
    }
    next(err);
  }
}
