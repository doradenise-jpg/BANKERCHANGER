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
router.get(
  '/',
  requireAuth,
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

      // Placeholder: In production, query from audit_logs or user_activity table
      const activities = [
        {
          id: '1',
          userId: query.userId || 'system',
          action: query.action || 'login',
          timestamp: new Date().toISOString(),
          metadata: { ip: req.ip, userAgent: req.headers['user-agent'] },
        },
      ];

      res.json({
        data: activities,
        pagination: {
          page: query.page,
          limit: query.limit,
          total: activities.length,
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
