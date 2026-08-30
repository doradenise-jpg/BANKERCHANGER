// backend/src/api/controllers/EngagementController.ts - Engagement Controller
// Gamification & notifications: streaks, achievement badges, referrals, leaderboard.
import type { Response } from 'express';
import { engagementService } from '../../services/engagement.service.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../utils/logger.js';

interface EngagementRequest {
  userId?: string;
  user?: { userId: string };
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: Record<string, unknown>;
}

function resolveUserId(req: EngagementRequest): string {
  return req.user?.userId ?? req.userId ?? '';
}

export class EngagementController {
  /**
   * GET /api/engagement/me — authenticated; returns streaks, badges, referrals.
   */
  async getMyEngagement(req: EngagementRequest, res: Response): Promise<Response> {
    try {
      const userId = resolveUserId(req);
      if (!userId) throw AppError.unauthorized('Missing authenticated user');
      const data = await engagementService.getUserEngagement(userId);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      logger.error('EngagementController.getMyEngagement error', { error });
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  /**
   * GET /api/engagement/leaderboard — authenticated; returns global leaderboard.
   */
  async getLeaderboard(req: EngagementRequest, res: Response): Promise<Response> {
    try {
      const limit = parseInt(req.query.limit ?? '50', 10) || 50;
      const data = await engagementService.getLeaderboard(limit);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      logger.error('EngagementController.getLeaderboard error', { error });
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  /**
   * POST /api/engagement/referrals — authenticated; records a referral edge.
   * body: { referredId: string }
   */
  async createReferral(req: EngagementRequest, res: Response): Promise<Response> {
    try {
      const userId = resolveUserId(req);
      if (!userId) throw AppError.unauthorized('Missing authenticated user');
      const referredId = req.body?.referredId as string | undefined;
      if (typeof referredId !== 'string' || !referredId.trim()) {
        throw AppError.badRequest('referredId is required');
      }
      const data = await engagementService.recordReferral(userId, referredId.trim());
      return res.status(201).json({ success: true, data });
    } catch (error: any) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      }
      logger.error('EngagementController.createReferral error', { error });
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }

  /**
   * GET /api/engagement/referrals/payouts — authenticated; computes referral payouts.
   */
  async getReferralPayouts(req: EngagementRequest, res: Response): Promise<Response> {
    try {
      const userId = resolveUserId(req);
      if (!userId) throw AppError.unauthorized('Missing authenticated user');
      const data = await engagementService.calculateReferralPayouts(userId);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      logger.error('EngagementController.getReferralPayouts error', { error });
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }
}

export const engagementController = new EngagementController();
