// ============================================================
// BANKERCHANGER — REST Endpoint Group 18: Affiliate & Referrals
// Addresses Issue #442 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import {
  createReferralCodeGroup18BodySchema,
  applyReferralCodeGroup18BodySchema,
  claimAffiliatePayoutGroup18BodySchema,
  listCampaignsGroup18QuerySchema,
  overrideAffiliateTierGroup18BodySchema,
  getAffiliateStatsGroup18QuerySchema,
} from '../schemas/affiliateGroup18.schemas';
import { validateBody, validateQuery } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';

const router = Router();

// Rate limiters for Group 18
const queryLimiter = rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' });
const mutationLimiter = rateLimit({ windowMs: 60_000, max: 15, keyBy: 'userId' });
const payoutLimiter = rateLimit({ windowMs: 60_000, max: 5, keyBy: 'userId' });
const adminLimiter = rateLimit({ windowMs: 60_000, max: 20, keyBy: 'ip' });

/**
 * @swagger
 * tags:
 *   name: Affiliates Group 18
 *   description: Affiliate Referrals, Commission Rebates & Partner Revenue Share (API Group 18)
 */

/**
 * @swagger
 * /api/v2/affiliates/codes/create:
 *   post:
 *     summary: Generate a custom referral vanity code and rebate split
 *     tags: [Affiliates Group 18]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/codes/create',
  requireAuth,
  mutationLimiter,
  validateBody(createReferralCodeGroup18BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { code, rebate_percentage_bps, campaign_name, creator_address } = req.body;

      const existingRes = await pool.query('SELECT id FROM affiliate_codes WHERE code = $1', [code]);
      if (existingRes.rows.length > 0) {
        throw AppError.conflict(`Referral code '${code}' is already taken`);
      }

      const insertRes = await pool.query(
        `INSERT INTO affiliate_codes (
          code, creator_id, creator_address, rebate_percentage_bps, campaign_name,
          commission_bps, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, 1000, 'active', NOW())
        RETURNING *`,
        [code, userId, creator_address, rebate_percentage_bps, campaign_name || 'Default Campaign']
      );

      res.status(201).json({
        success: true,
        message: 'Referral code created successfully',
        data: insertRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/affiliates/referrals/apply:
 *   post:
 *     summary: Apply a referral code to associate referee with an affiliate
 *     tags: [Affiliates Group 18]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/referrals/apply',
  requireAuth,
  mutationLimiter,
  validateBody(applyReferralCodeGroup18BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { referral_code, referee_address } = req.body;

      const codeRes = await pool.query(
        'SELECT id, creator_id, rebate_percentage_bps, status FROM affiliate_codes WHERE code = $1',
        [referral_code]
      );

      if (codeRes.rows.length === 0) {
        throw AppError.notFound(`Referral code '${referral_code}' not found`);
      }

      const codeData = codeRes.rows[0];
      if (codeData.status !== 'active') {
        throw AppError.badRequest(`Referral code '${referral_code}' is ${codeData.status}`);
      }

      if (codeData.creator_id === userId) {
        throw AppError.badRequest('You cannot apply your own referral code');
      }

      const insertRes = await pool.query(
        `INSERT INTO affiliate_referrals (affiliate_code_id, referee_user_id, referee_address, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (referee_user_id) DO NOTHING
         RETURNING *`,
        [codeData.id, userId, referee_address]
      );

      if (insertRes.rows.length === 0) {
        throw AppError.badRequest('User has already been referred previously');
      }

      res.status(200).json({
        success: true,
        message: 'Referral code applied successfully',
        data: {
          referral_code,
          rebate_percentage_bps: codeData.rebate_percentage_bps,
          applied_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/affiliates/dashboard:
 *   get:
 *     summary: Retrieve authenticated affiliate dashboard performance metrics
 *     tags: [Affiliates Group 18]
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/dashboard',
  requireAuth,
  queryLimiter,
  validateQuery(getAffiliateStatsGroup18QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { period } = req.query as unknown as { period: string };

      const codesRes = await pool.query(
        `SELECT
          ac.id,
          ac.code,
          ac.campaign_name,
          ac.commission_bps,
          ac.rebate_percentage_bps,
          COUNT(ar.id)::int AS referrals_count,
          COALESCE(SUM(b.amount::numeric), 0)::text AS total_volume_stroops,
          COALESCE(SUM(b.amount::numeric * (ac.commission_bps::numeric / 10000)), 0)::text AS total_earnings_stroops
        FROM affiliate_codes ac
        LEFT JOIN affiliate_referrals ar ON ar.affiliate_code_id = ac.id
        LEFT JOIN bets b ON b.user_id = ar.referee_user_id
        WHERE ac.creator_id = $1
        GROUP BY ac.id`,
        [userId]
      );

      const balanceRes = await pool.query(
        `SELECT
          COALESCE(unclaimed_commissions_stroops, '0') AS unclaimed_commissions_stroops,
          COALESCE(total_paid_stroops, '0') AS total_paid_stroops,
          COALESCE(tier, 'bronze') AS tier
         FROM affiliate_profiles
         WHERE user_id = $1`,
        [userId]
      );

      const profile = balanceRes.rows[0] || {
        unclaimed_commissions_stroops: '0',
        total_paid_stroops: '0',
        tier: 'bronze',
      };

      res.status(200).json({
        success: true,
        data: {
          period,
          profile,
          campaigns: codesRes.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/affiliates/payouts/claim:
 *   post:
 *     summary: Claim accrued affiliate commissions to Stellar wallet
 *     tags: [Affiliates Group 18]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/payouts/claim',
  requireAuth,
  payoutLimiter,
  validateBody(claimAffiliatePayoutGroup18BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { recipient_address, amount_stroops, destination_memo } = req.body;

      const profileRes = await pool.query(
        'SELECT unclaimed_commissions_stroops FROM affiliate_profiles WHERE user_id = $1',
        [userId]
      );

      const unclaimed = profileRes.rows[0]?.unclaimed_commissions_stroops || '0';
      const claimAmount = amount_stroops || unclaimed;

      if (BigInt(claimAmount) <= 0n || BigInt(claimAmount) > BigInt(unclaimed)) {
        throw AppError.badRequest(`Insufficient unclaimed commissions balance (Available: ${unclaimed} stroops)`);
      }

      await pool.query(
        `UPDATE affiliate_profiles
         SET
           unclaimed_commissions_stroops = (unclaimed_commissions_stroops::numeric - $1::numeric)::text,
           total_paid_stroops = (total_paid_stroops::numeric + $1::numeric)::text,
           updated_at = NOW()
         WHERE user_id = $2`,
        [claimAmount, userId]
      );

      const payoutRes = await pool.query(
        `INSERT INTO affiliate_payouts (user_id, recipient_address, amount_stroops, destination_memo, status, created_at)
         VALUES ($1, $2, $3, $4, 'processed', NOW())
         RETURNING *`,
        [userId, recipient_address, claimAmount, destination_memo || null]
      );

      res.status(200).json({
        success: true,
        message: 'Commission payout processed successfully',
        data: payoutRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/affiliates/campaigns:
 *   get:
 *     summary: List marketing campaigns and referral performance
 *     tags: [Affiliates Group 18]
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/campaigns',
  requireAuth,
  queryLimiter,
  validateQuery(listCampaignsGroup18QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { status, page, limit, sort_by, sort_order } = req.query as unknown as {
        status: string;
        page: number;
        limit: number;
        sort_by: string;
        sort_order: string;
      };

      const offset = (page - 1) * limit;

      const result = await pool.query(
        `SELECT
          ac.*,
          COUNT(ar.id)::int AS referrals_count
        FROM affiliate_codes ac
        LEFT JOIN affiliate_referrals ar ON ar.affiliate_code_id = ac.id
        WHERE ac.creator_id = $1 AND ($2 = 'all' OR ac.status = $2)
        GROUP BY ac.id
        ORDER BY
          CASE WHEN $3 = 'created_at' AND $4 = 'desc' THEN ac.created_at END DESC,
          CASE WHEN $3 = 'created_at' AND $4 = 'asc' THEN ac.created_at END ASC,
          CASE WHEN $3 = 'referrals_count' AND $4 = 'desc' THEN COUNT(ar.id) END DESC,
          CASE WHEN $3 = 'referrals_count' AND $4 = 'asc' THEN COUNT(ar.id) END ASC,
          ac.created_at DESC
        LIMIT $5 OFFSET $6`,
        [userId, status, sort_by, sort_order, limit, offset]
      );

      res.status(200).json({
        success: true,
        data: {
          page,
          limit,
          campaigns: result.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/affiliates/admin/tier-override:
 *   patch:
 *     summary: Override affiliate tier and commission basis points (Admin only)
 *     tags: [Affiliates Group 18]
 *     security:
 *       - bearerAuth: []
 */
router.patch(
  '/admin/tier-override',
  requireAdminJwt,
  adminLimiter,
  validateBody(overrideAffiliateTierGroup18BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user_id, tier, custom_commission_bps, reason } = req.body;

      const result = await pool.query(
        `INSERT INTO affiliate_profiles (user_id, tier, custom_commission_bps, admin_notes, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET
           tier = EXCLUDED.tier,
           custom_commission_bps = EXCLUDED.custom_commission_bps,
           admin_notes = EXCLUDED.admin_notes,
           updated_at = NOW()
         RETURNING *`,
        [user_id, tier, custom_commission_bps, reason]
      );

      res.status(200).json({
        success: true,
        message: 'Affiliate tier override applied successfully',
        data: result.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/affiliates/leaderboard:
 *   get:
 *     summary: Public affiliate leaderboards by total volume generated
 *     tags: [Affiliates Group 18]
 */
router.get(
  '/leaderboard',
  queryLimiter,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `SELECT
          u.username,
          ac.code,
          COUNT(ar.id)::int AS total_referrals,
          COALESCE(SUM(b.amount::numeric), 0)::text AS total_volume_generated_stroops
        FROM affiliate_codes ac
        JOIN users u ON u.id = ac.creator_id
        LEFT JOIN affiliate_referrals ar ON ar.affiliate_code_id = ac.id
        LEFT JOIN bets b ON b.user_id = ar.referee_user_id
        GROUP BY u.username, ac.code
        ORDER BY total_volume_generated_stroops DESC
        LIMIT 20`
      );

      res.status(200).json({
        success: true,
        data: {
          leaderboard: result.rows,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
