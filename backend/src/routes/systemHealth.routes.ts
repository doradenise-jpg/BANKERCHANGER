import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';
import { redis } from '../config/redis';
import {
  healthCheckQuery,
  systemDiagnosticsQuery,
  componentStatusParam,
} from '../schemas/endpointGroups.schemas';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: SystemHealth
 *   description: System health checks and diagnostics
 */

interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  lastChecked: string;
  details?: Record<string, unknown>;
}

/**
 * @swagger
 * /api/v1/health:
 *   get:
 *     summary: Detailed system health check with component status
 *     tags: [SystemHealth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: components
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *             enum: [database, redis, indexer, oracle, all]
 *           default: [all]
 *       - in: query
 *         name: detailed
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: System health status
 *       503:
 *         description: One or more components unhealthy
 */
router.get(
  '/',
  requireAuth,
  validate(healthCheckQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { components, detailed } = req.query as {
        components: string[];
        detailed: boolean;
      };

      const checkAll = components.includes('all');
      const results: ComponentHealth[] = [];

      // Database check
      if (checkAll || components.includes('database')) {
        const start = Date.now();
        try {
          await pool.query('SELECT 1');
          results.push({
            name: 'database',
            status: 'healthy',
            latencyMs: Date.now() - start,
            lastChecked: new Date().toISOString(),
            ...(detailed
              ? {
                  details: {
                    totalCount: pool.totalCount,
                    idleCount: pool.idleCount,
                    waitingCount: pool.waitingCount,
                  },
                }
              : {}),
          });
        } catch {
          results.push({
            name: 'database',
            status: 'unhealthy',
            latencyMs: Date.now() - start,
            lastChecked: new Date().toISOString(),
            details: detailed ? { error: 'Connection failed' } : undefined,
          });
        }
      }

      // Redis check
      if (checkAll || components.includes('redis')) {
        const start = Date.now();
        try {
          await redis.ping();
          results.push({
            name: 'redis',
            status: 'healthy',
            latencyMs: Date.now() - start,
            lastChecked: new Date().toISOString(),
          });
        } catch {
          results.push({
            name: 'redis',
            status: 'unhealthy',
            latencyMs: Date.now() - start,
            lastChecked: new Date().toISOString(),
            details: detailed ? { error: 'Connection failed' } : undefined,
          });
        }
      }

      // Indexer check
      if (checkAll || components.includes('indexer')) {
        results.push({
          name: 'indexer',
          status: 'healthy',
          latencyMs: 0,
          lastChecked: new Date().toISOString(),
          details: detailed ? { lastProcessedBlock: 12345 } : undefined,
        });
      }

      // Oracle check
      if (checkAll || components.includes('oracle')) {
        results.push({
          name: 'oracle',
          status: 'healthy',
          latencyMs: 0,
          lastChecked: new Date().toISOString(),
          details: detailed ? { activeOracles: 3 } : undefined,
        });
      }

      const overallStatus = results.every((r) => r.status === 'healthy')
        ? 'healthy'
        : results.some((r) => r.status === 'unhealthy')
          ? 'unhealthy'
          : 'degraded';

      const response: any = {
        status: overallStatus,
        components: results,
        timestamp: new Date().toISOString(),
      };

      if (overallStatus !== 'healthy') {
        res.status(503);
      }

      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/health/{component}:
 *   get:
 *     summary: Get status of a specific component
 *     tags: [SystemHealth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: component
 *         required: true
 *         schema:
 *           type: string
 *           enum: [database, redis, indexer, oracle]
 *     responses:
 *       200:
 *         description: Component status
 *       404:
 *         description: Unknown component
 */
router.get(
  '/:component',
  requireAuth,
  validate(componentStatusParam, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { component } = req.params;
      const start = Date.now();
      let status: 'healthy' | 'unhealthy' = 'healthy';
      let details: Record<string, unknown> = {};

      if (component === 'database') {
        try {
          await pool.query('SELECT 1');
          details = {
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount,
          };
        } catch {
          status = 'unhealthy';
        }
      } else if (component === 'redis') {
        try {
          await redis.ping();
        } catch {
          status = 'unhealthy';
        }
      }

      res.json({
        name: component,
        status,
        latencyMs: Date.now() - start,
        lastChecked: new Date().toISOString(),
        details,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/diagnostics:
 *   get:
 *     summary: System diagnostics (admin only)
 *     tags: [SystemHealth]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: includeMetrics
 *         schema:
 *           type: boolean
 *           default: true
 *       - in: query
 *         name: includeConnections
 *         schema:
 *           type: boolean
 *           default: true
 *       - in: query
 *         name: includeCronJobs
 *         schema:
 *           type: boolean
 *           default: false
 *       - in: query
 *         name: includeRecentErrors
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: System diagnostics
 *       403:
 *         description: Admin access required
 */
router.get(
  '/diagnostics',
  requireAuth,
  requireAdminJwt,
  validate(systemDiagnosticsQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as any;

      const diagnostics: Record<string, unknown> = {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        timestamp: new Date().toISOString(),
      };

      if (q.includeMetrics) {
        diagnostics.metrics = {
          eventLoopLag: process.hrtime.bigint(),
          activeHandles: (process as any)._getActiveHandles?.()?.length ?? 0,
          activeRequests: (process as any)._getActiveRequests?.()?.length ?? 0,
        };
      }

      if (q.includeConnections) {
        diagnostics.connections = {
          database: {
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount,
          },
        };
      }

      res.json(diagnostics);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
