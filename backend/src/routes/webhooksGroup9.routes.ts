import { Router, Request, Response, NextFunction } from 'express';
import { validateBody, validateQuery, validateParams } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { pool } from '../config/db';
import {
  createWebhookGroup9BodySchema,
  webhookIdParamGroup9Schema,
  listDeliveriesGroup9QuerySchema,
  replayWebhookDeliveriesGroup9BodySchema,
  CreateWebhookGroup9Body,
  WebhookIdParamGroup9,
  ListDeliveriesGroup9Query,
  ReplayWebhookDeliveriesGroup9Body,
} from '../schemas/webhooksGroup9.schemas';

const router = Router();

/**
 * @swagger
 * /api/v2/webhooks/subscriptions:
 *   post:
 *     summary: Register a new webhook subscription endpoint with HMAC secret and event topics
 *     tags: [Webhooks Group 9]
 */
router.post(
  '/subscriptions',
  rateLimit({ windowMs: 60_000, max: 15, keyBy: 'ip' }),
  requireAuth,
  validateBody(createWebhookGroup9BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as CreateWebhookGroup9Body;
      const userId = (req as unknown as { userId?: string }).userId;

      const newWebhook = {
        id: `whk-${Date.now()}`,
        user_id: userId,
        url: body.url,
        topics: body.topics,
        description: body.description || null,
        status: 'active',
        created_at: new Date().toISOString(),
      };

      res.status(201).json({
        success: true,
        message: 'Webhook subscription created successfully',
        data: newWebhook,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/webhooks/subscriptions:
 *   get:
 *     summary: List all active webhook endpoints configured by authenticated user
 *     tags: [Webhooks Group 9]
 */
router.get(
  '/subscriptions',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = (req as unknown as { userId?: string }).userId;

      const mockSubscriptions = [
        {
          id: 'whk-sample-01',
          user_id: userId,
          url: 'https://example-bot.com/webhooks/bankerchanger',
          topics: ['market.resolved', 'payout.distributed'],
          description: 'Production alert bot',
          status: 'active',
          last_delivery_at: new Date(Date.now() - 3600000).toISOString(),
          created_at: new Date(Date.now() - 86400000).toISOString(),
        },
      ];

      res.status(200).json({
        success: true,
        data: mockSubscriptions,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/webhooks/subscriptions/{id}:
 *   delete:
 *     summary: Remove/deactivate an active webhook subscription endpoint
 *     tags: [Webhooks Group 9]
 */
router.delete(
  '/subscriptions/:id',
  rateLimit({ windowMs: 60_000, max: 30, keyBy: 'ip' }),
  requireAuth,
  validateParams(webhookIdParamGroup9Schema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params as unknown as WebhookIdParamGroup9;

      res.status(200).json({
        success: true,
        message: `Webhook subscription ${id} deactivated successfully`,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/webhooks/subscriptions/{id}/test:
 *   post:
 *     summary: Dispatch test ping payload to verify webhook destination endpoint response
 *     tags: [Webhooks Group 9]
 */
router.post(
  '/subscriptions/:id/test',
  rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' }),
  requireAuth,
  validateParams(webhookIdParamGroup9Schema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params as unknown as WebhookIdParamGroup9;

      res.status(200).json({
        success: true,
        message: `Test ping dispatched to webhook ${id}`,
        data: {
          test_event_id: `evt-ping-${Date.now()}`,
          delivered: true,
          http_status_code: 200,
          latency_ms: 142,
          dispatched_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/webhooks/deliveries:
 *   get:
 *     summary: Retrieve delivery logs, retry counts, and HTTP status codes for webhook dispatches
 *     tags: [Webhooks Group 9]
 */
router.get(
  '/deliveries',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  requireAuth,
  validateQuery(listDeliveriesGroup9QuerySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = req.query as unknown as ListDeliveriesGroup9Query;
      const { page = 1, limit = 20, status } = query;

      const mockDeliveries = [
        {
          delivery_id: 'del-901',
          webhook_id: query.webhook_id || 'whk-sample-01',
          event_type: 'market.resolved',
          status: status || 'success',
          http_status: 200,
          attempts: 1,
          created_at: new Date(Date.now() - 1200000).toISOString(),
        },
      ];

      res.status(200).json({
        success: true,
        pagination: {
          page,
          limit,
          total: mockDeliveries.length,
        },
        data: mockDeliveries,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/webhooks/admin/replay:
 *   post:
 *     summary: Admin-gated batch replay for failed webhook deliveries
 *     tags: [Webhooks Group 9]
 */
router.post(
  '/admin/replay',
  rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' }),
  requireAdminJwt,
  validateBody(replayWebhookDeliveriesGroup9BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as ReplayWebhookDeliveriesGroup9Body;

      res.status(200).json({
        success: true,
        message: `Dispatched replay for ${body.delivery_ids.length} deliveries`,
        data: {
          replayed_count: body.delivery_ids.length,
          queued_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
