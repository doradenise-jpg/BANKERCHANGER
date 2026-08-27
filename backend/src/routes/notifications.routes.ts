import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { AppError } from '../utils/AppError';
import {
  getNotificationSettingsParam,
  updateNotificationSettingsBody,
  testNotificationBody,
} from '../schemas/endpointGroups.schemas';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: Notification and alert preference management
 */

// In-memory store (production: use database)
const notificationSettings = new Map<string, Record<string, unknown>>();

/**
 * @swagger
 * /api/v1/notifications/{userId}/settings:
 *   get:
 *     summary: Get notification settings for a user
 *     tags: [Notifications]
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
 *         description: Notification settings
 *       403:
 *         description: Cannot view another user's settings
 */
router.get(
  '/:userId/settings',
  requireAuth,
  validate(getNotificationSettingsParam, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const authUser = (req as any).user;

      if (authUser.id !== userId && authUser.role !== 'admin') {
        throw new AppError(403, 'Cannot view another user\'s notification settings');
      }

      const settings = notificationSettings.get(userId) || {
        betPlaced: true,
        betResolved: true,
        betWon: true,
        claimProcessed: true,
        marketCreated: false,
        marketLocked: true,
        disputeFiled: true,
        disputeResolved: true,
        securityAlert: true,
        systemMaintenance: true,
        channel: 'both',
        quietHoursStart: null,
        quietHoursEnd: null,
      };

      res.json({ userId, settings });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/notifications/{userId}/settings:
 *   put:
 *     summary: Update notification settings
 *     tags: [Notifications]
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
 *               betPlaced:
 *                 type: boolean
 *               betResolved:
 *                 type: boolean
 *               channel:
 *                 type: string
 *                 enum: [email, push, both, none]
 *               quietHoursStart:
 *                 type: string
 *                 pattern: '^\\d{2}:\\d{2}$'
 *               quietHoursEnd:
 *                 type: string
 *                 pattern: '^\\d{2}:\\d{2}$'
 *     responses:
 *       200:
 *         description: Settings updated
 *       403:
 *         description: Cannot modify another user's settings
 *       422:
 *         description: Validation error
 */
router.put(
  '/:userId/settings',
  requireAuth,
  validate(getNotificationSettingsParam, 'params'),
  validate(updateNotificationSettingsBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.params;
      const authUser = (req as any).user;

      if (authUser.id !== userId && authUser.role !== 'admin') {
        throw new AppError(403, 'Cannot modify another user\'s notification settings');
      }

      const existing = notificationSettings.get(userId) || {};
      const updated = { ...existing, ...req.body };
      notificationSettings.set(userId, updated);

      res.json({
        message: 'Notification settings updated',
        userId,
        settings: updated,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/notifications/test:
 *   post:
 *     summary: Send a test notification
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, userId, template]
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [email, push]
 *               userId:
 *                 type: string
 *                 format: uuid
 *               template:
 *                 type: string
 *                 enum: [bet_placed, bet_resolved, security_alert, system_maintenance]
 *     responses:
 *       200:
 *         description: Test notification sent
 *       422:
 *         description: Validation error
 */
router.post(
  '/test',
  requireAuth,
  validate(testNotificationBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type, userId, template } = req.body;

      // Placeholder: In production, actually send the notification
      res.json({
        message: `Test ${type} notification sent`,
        userId,
        template,
        sentAt: new Date().toISOString(),
        deliveryId: `dlv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
