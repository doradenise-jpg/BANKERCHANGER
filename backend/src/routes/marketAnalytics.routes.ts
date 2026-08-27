import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { AppError } from '../utils/AppError';
import {
  marketAnalyticsQuery,
  generateReportBody,
  reportIdParam,
} from '../schemas/endpointGroups.schemas';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: MarketAnalytics
 *   description: Market analytics and reporting
 */

// In-memory report store (production: use database)
const reportJobs = new Map<string, { status: string; createdAt: string; type: string }>();

/**
 * @swagger
 * /api/v1/analytics/markets:
 *   get:
 *     summary: Get market analytics with configurable metrics
 *     tags: [MarketAnalytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: marketId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [1h, 6h, 24h, 7d, 30d]
 *           default: 24h
 *       - in: query
 *         name: metrics
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *             enum: [total_volume, total_bets, unique_bettors, avg_bet_size, liquidity_depth, odds_movement]
 *     responses:
 *       200:
 *         description: Market analytics data
 *       422:
 *         description: Validation error
 */
router.get(
  '/markets',
  requireAuth,
  validate(marketAnalyticsQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { marketId, period, metrics } = req.query as {
        marketId?: string;
        period: string;
        metrics?: string[];
      };

      // Placeholder analytics data
      const analytics = {
        period,
        marketId: marketId || 'all',
        metrics: {
          total_volume: 125000,
          total_bets: 3420,
          unique_bettors: 891,
          avg_bet_size: 36.55,
          liquidity_depth: 45000,
          odds_movement: { a: [1.8, 1.75, 1.72], b: [2.1, 2.15, 2.2] },
        },
        generatedAt: new Date().toISOString(),
      };

      // Filter to requested metrics if specified
      if (metrics && metrics.length > 0) {
        const filtered: Record<string, unknown> = {};
        for (const m of metrics) {
          if ((analytics.metrics as any)[m] !== undefined) {
            filtered[m] = (analytics.metrics as any)[m];
          }
        }
        (analytics as any).metrics = filtered;
      }

      res.json(analytics);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/analytics/reports:
 *   post:
 *     summary: Generate a new analytics report (async)
 *     tags: [MarketAnalytics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reportType, from, to]
 *             properties:
 *               reportType:
 *                 type: string
 *                 enum: [market_summary, user_activity, financial, dispute_summary, provider_performance]
 *               from:
 *                 type: string
 *                 format: date-time
 *               to:
 *                 type: string
 *                 format: date-time
 *               format:
 *                 type: string
 *                 enum: [json, csv]
 *                 default: json
 *     responses:
 *       202:
 *         description: Report generation started
 *       422:
 *         description: Validation error
 */
router.post(
  '/reports',
  requireAuth,
  validate(generateReportBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reportType, from, to, format } = req.body;
      const reportId = `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      reportJobs.set(reportId, {
        status: 'processing',
        createdAt: new Date().toISOString(),
        type: reportType,
      });

      // Simulate async report generation
      setTimeout(() => {
        const job = reportJobs.get(reportId);
        if (job) job.status = 'completed';
      }, 5000);

      res.status(202).json({
        reportId,
        status: 'processing',
        type: reportType,
        period: { from, to },
        format,
        estimatedCompletionSeconds: 5,
        pollUrl: `/api/v1/analytics/reports/${reportId}`,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/analytics/reports/{reportId}:
 *   get:
 *     summary: Get report generation status or result
 *     tags: [MarketAnalytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: reportId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Report status or result
 *       404:
 *         description: Report not found
 */
router.get(
  '/reports/:reportId',
  requireAuth,
  validate(reportIdParam, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reportId } = req.params;
      const job = reportJobs.get(reportId);

      if (!job) {
        throw new AppError(404, 'Report not found');
      }

      res.json({
        reportId,
        status: job.status,
        type: job.type,
        createdAt: job.createdAt,
        ...(job.status === 'completed'
          ? {
              downloadUrl: `/api/v1/analytics/reports/${reportId}/download`,
              completedAt: new Date().toISOString(),
            }
          : {}),
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
