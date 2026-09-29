import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import {
  getUserActivityQuery,
  updateUserPreferencesBody,
  userPreferencesParam,
} from '../schemas/endpointGroups.schemas';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: UserActivity
 *   description: User activity logging and preference management
 */

/**
 * @swagger
 * /api/v1/user-activity:
 *   get:
 *     summary: Get user activity log with filtering
 *     tags: [UserActivity]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *           enum: [login, logout, bet_placed, bet_claimed, profile_updated, 2fa_enabled, 2fa_disabled]
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
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
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Paginated user activity log
 *       422:
 *         description: Validation error
 */
import jwt from 'jsonwebtoken';
import { getEnv } from '../config/env';

export const PRIVATE_ACTIONS = new Set([
  'login',
  'logout',
  '2fa_enabled',
  '2fa_disabled',
  'password_change',
  'failed_login',
  'session_revoked',
]);

/** Determine whether an activity action is public or private (Issue #684) */
export function getActivityVisibility(action: string): 'public' | 'private' {
  return PRIVATE_ACTIONS.has(action) ? 'private' : 'public';
}

/**
 * @swagger
 * /api/v1/user-activity:
 *   get:
 *     summary: Get user activity log with privacy filtering (Issue #684)
 *     tags: [UserActivity]
 */
router.get(
  '/',
  validate(getUserActivityQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query as {
        userId?: string;
        action?: string;
        from?: string;
        to?: string;
        page: number;
        limit: number;
      };

      // Determine authenticated user from Bearer token if present
      let authenticatedUserId: string | null = (req as any).user?.id || (req as any).userId || null;
      const authHeader = req.headers.authorization;
      if (!authenticatedUserId && authHeader?.startsWith('Bearer ')) {
        try {
          const token = authHeader.slice(7);
          const env = getEnv();
          const payload = jwt.verify(token, env.JWT_ACCESS_SECRET || env.JWT_SECRET) as any;
          authenticatedUserId = payload.sub || payload.userId || null;
        } catch {
          // Unauthenticated or expired token
        }
      }

      const targetUserId = query.userId || 'system';
      const isOwnerOrAdmin =
        authenticatedUserId !== null &&
        (authenticatedUserId === targetUserId || (req as any).user?.role === 'admin');

      // Sample activity events tagged with visibility: 'public' | 'private'
      const allActivities = [
        {
          id: '1',
          userId: targetUserId,
          action: 'bet_placed',
          visibility: 'public' as const,
          timestamp: new Date(Date.now() - 3600_000).toISOString(),
          metadata: { amount: 100, marketId: 'mkt-1' },
        },
        {
          id: '2',
          userId: targetUserId,
          action: 'login',
          visibility: 'private' as const,
          timestamp: new Date(Date.now() - 1800_000).toISOString(),
          metadata: { ip: req.ip, userAgent: req.headers['user-agent'] },
        },
        {
          id: '3',
          userId: targetUserId,
          action: '2fa_enabled',
          visibility: 'private' as const,
          timestamp: new Date(Date.now() - 1200_000).toISOString(),
          metadata: { method: 'totp' },
        },
        {
          id: '4',
          userId: targetUserId,
          action: 'bet_claimed',
          visibility: 'public' as const,
          timestamp: new Date().toISOString(),
          metadata: { payout: 185 },
        },
      ];

      // If specific action is requested, tag it dynamically
      let filtered = allActivities;
      if (query.action) {
        filtered = [
          {
            id: 'custom-1',
            userId: targetUserId,
            action: query.action,
            visibility: getActivityVisibility(query.action),
            timestamp: new Date().toISOString(),
            metadata: {},
          },
        ];
      }

      // Filter: Unauthenticated or non-owner requests receive ONLY public events
      if (!isOwnerOrAdmin) {
        filtered = filtered.filter((act) => act.visibility === 'public');
      }

      res.json({
        data: filtered,
        pagination: {
          page: query.page,
          limit: query.limit,
          total: filtered.length,
          totalPages: 1,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/user-activity/{userId}/preferences:
 *   put:
 *     summary: Update user preferences
 *     tags: [UserActivity]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               emailNotifications:
 *                 type: boolean
 *               pushNotifications:
 *                 type: boolean
 *               marketingEmails:
 *                 type: boolean
 *               defaultCurrency:
 *                 type: string
 *                 enum: [USD, EUR, GBP, XLM]
 *               oddsFormat:
 *                 type: string
 *                 enum: [decimal, fractional, american]
 *               language:
 *                 type: string
 *                 enum: [en, es, fr, de, pt]
 *               timezone:
 *                 type: string
 *     responses:
 *       200:
 *         description: Preferences updated
 *       403:
 *         description: Cannot modify another user's preferences
 *       422:
 *         description: Validation error
 */
router.put(
  '/:userId/preferences',
  requireAuth,
  validate(userPreferencesParam, 'params'),
  validate(updateUserPreferencesBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const authUser = (req as any).user;

      if (authUser.id !== userId && authUser.role !== 'admin') {
        throw new AppError(403, 'Cannot modify another user\'s preferences');
      }

      // Placeholder: In production, update user_preferences table
      res.json({
        message: 'Preferences updated successfully',
        userId,
        preferences: req.body,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/user-activity/{userId}/preferences:
 *   get:
 *     summary: Get user preferences
 *     tags: [UserActivity]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: User preferences
 *       403:
 *         description: Cannot view another user's preferences
 */
router.get(
  '/:userId/preferences',
  requireAuth,
  validate(userPreferencesParam, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const authUser = (req as any).user;

      if (authUser.id !== userId && authUser.role !== 'admin') {
        throw new AppError(403, 'Cannot view another user\'s preferences');
      }

      // Placeholder: In production, fetch from user_preferences table
      res.json({
        userId,
        preferences: {
          emailNotifications: true,
          pushNotifications: true,
          marketingEmails: false,
          defaultCurrency: 'USD',
          oddsFormat: 'decimal',
          language: 'en',
          timezone: 'UTC',
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
