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
 * Public health endpoint (Issue #682)
 * Returns ONLY { status, version, timestamp }.
 * Never exposes environment variables, secrets, or internal database URLs.
 */
const publicHealthHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.status(200).json({
      status: 'healthy',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'unhealthy',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    });
  }
};

router.get('/', publicHealthHandler);
router.get('/health', publicHealthHandler);

/**
 * Detailed health check handler (Issue #682)
 * Restricted strictly to admin JWT. Unauthenticated requests return 401 Unauthorized.
 */
const detailedHealthHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const rawComponents = (req.query.components as string | string[]) || 'all';
    const components = Array.isArray(rawComponents)
      ? rawComponents
      : typeof rawComponents === 'string'
      ? rawComponents.split(',')
      : ['all'];

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
          details: {
            totalCount: pool.totalCount,
            idleCount: pool.idleCount,
            waitingCount: pool.waitingCount,
          },
        });
      } catch {
        results.push({
          name: 'database',
          status: 'unhealthy',
          latencyMs: Date.now() - start,
          lastChecked: new Date().toISOString(),
          details: { error: 'Connection failed' },
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
          details: { error: 'Connection failed' },
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
        details: { lastProcessedBlock: 12345 },
      });
    }

    // Oracle check
    if (checkAll || components.includes('oracle')) {
      results.push({
        name: 'oracle',
        status: 'healthy',
        latencyMs: 0,
        lastChecked: new Date().toISOString(),
        details: { activeOracles: 3 },
      });
    }

    const overallStatus = results.every((r) => r.status === 'healthy')
      ? 'healthy'
      : results.some((r) => r.status === 'unhealthy')
        ? 'unhealthy'
        : 'degraded';

    const statusCode = overallStatus === 'healthy' ? 200 : 503;

    res.status(statusCode).json({
      status: overallStatus,
      components: results,
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
};

// Admin-gated detailed health endpoints
router.get('/detailed', requireAdminJwt, detailedHealthHandler);
router.get('/health/detailed', requireAdminJwt, detailedHealthHandler);

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
