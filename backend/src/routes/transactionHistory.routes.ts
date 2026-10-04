import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import {
  getTransactionHistoryQuery,
  exportTransactionsBody,
} from '../schemas/endpointGroups.schemas';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: TransactionHistory
 *   description: Transaction history and export endpoints
 */

/**
 * @swagger
 * /api/v1/transactions:
 *   get:
 *     summary: Get paginated transaction history with advanced filtering
 *     tags: [TransactionHistory]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [bet, claim, refund, deposit, withdrawal]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, completed, failed, cancelled]
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
 *         name: minAmount
 *         schema:
 *           type: number
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [created_at, amount, status]
 *           default: created_at
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *     responses:
 *       200:
 *         description: Paginated transaction history
 *       422:
 *         description: Validation error
 */
router.get(
  '/',
  requireAuth,
  validate(getTransactionHistoryQuery, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.query as any;

      // Placeholder: In production, query from transactions table
      const transactions = [
        {
          id: 'txn_001',
          userId: q.userId || 'current_user',
          type: q.type || 'bet',
          amount: '100000000',
          status: q.status || 'completed',
          marketId: '550e8400-e29b-41d4-a716-446655440000',
          createdAt: new Date().toISOString(),
        },
      ];

      // Apply in-memory filtering for demo
      let filtered = transactions;
      if (q.minAmount) {
        filtered = filtered.filter((t) => BigInt(t.amount) >= BigInt(q.minAmount));
      }
      if (q.maxAmount) {
        filtered = filtered.filter((t) => BigInt(t.amount) <= BigInt(q.maxAmount));
      }

      // Sort
      filtered.sort((a, b) => {
        const aVal = a[q.sortBy as keyof typeof a] ?? '';
        const bVal = b[q.sortBy as keyof typeof b] ?? '';
        const cmp = String(aVal).localeCompare(String(bVal));
        return q.sortOrder === 'desc' ? -cmp : cmp;
      });

      res.json({
        data: filtered,
        pagination: {
          page: q.page,
          limit: q.limit,
          total: filtered.length,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
        filters: {
          type: q.type,
          status: q.status,
          dateRange: { from: q.from, to: q.to },
          amountRange: { min: q.minAmount, max: q.maxAmount },
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v1/transactions/export:
 *   post:
 *     summary: Export transactions as CSV or JSON
 *     tags: [TransactionHistory]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               format:
 *                 type: string
 *                 enum: [csv, json]
 *                 default: csv
 *               filters:
 *                 type: object
 *                 properties:
 *                   userId:
 *                     type: string
 *                     format: uuid
 *                   type:
 *                     type: string
 *                   status:
 *                     type: string
 *                   from:
 *                     type: string
 *                     format: date-time
 *                   to:
 *                     type: string
 *                     format: date-time
 *               columns:
 *                 type: array
 *                 items:
 *                   type: string
 *                 maxItems: 30
 *     responses:
 *       200:
 *         description: Exported data
 *       422:
 *         description: Validation error
 */
router.post(
  '/export',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 5, keyBy: 'userId' }),
  validate(exportTransactionsBody, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { format, filters, columns } = req.body;

      // 1. Enforce 90-day maximum date range limit (Issue #686)
      if (filters?.from && filters?.to) {
        const fromTime = new Date(filters.from).getTime();
        const toTime = new Date(filters.to).getTime();
        if (isNaN(fromTime) || isNaN(toTime)) {
          throw AppError.badRequest('Invalid from/to date format');
        }
        const diffDays = (toTime - fromTime) / (1000 * 60 * 60 * 24);
        if (diffDays > 90 || diffDays < 0) {
          res.status(413).json({
            success: false,
            error: 'Payload Too Large',
            message: 'Transaction history export is limited to a maximum 90-day date range per request. Please narrow your date range.',
          });
          return;
        }
      }

      const defaultColumns = [
        'id', 'userId', 'type', 'amount', 'status',
        'marketId', 'createdAt',
      ];
      const selectedColumns = columns && columns.length > 0
        ? columns.filter((c) => defaultColumns.includes(c))
        : defaultColumns;

      // Placeholder export data (in production queried from DB or stream)
      const data = [
        {
          id: 'txn_001',
          userId: 'current_user',
          type: 'bet',
          amount: '100000000',
          status: 'completed',
          marketId: '550e8400-e29b-41d4-a716-446655440000',
          createdAt: new Date().toISOString(),
        },
      ];

      // 2. Enforce 100,000 maximum record count limit (Issue #686)
      const totalEstimated = (req.body as any).estimated_count ?? data.length;
      if (totalEstimated > 100_000) {
        res.status(413).json({
          success: false,
          error: 'Payload Too Large',
          message: 'Export exceeds maximum record count limit of 100,000 rows. Please specify a narrower date range or add filters.',
        });
        return;
      }

      // 3. Streaming response (avoids buffering full dataset in memory)
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');

        // Write CSV header
        res.write(selectedColumns.join(',') + '\n');

        // Stream CSV rows
        for (const row of data) {
          const line = selectedColumns.map((col) => {
            const val = (row as any)[col];
            return typeof val === 'string' && val.includes(',')
              ? `"${val}"`
              : String(val ?? '');
          }).join(',') + '\n';
          res.write(line);
        }
        res.end();
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="transactions.json"');

        res.write('{"data":[');
        for (let i = 0; i < data.length; i++) {
          const row = data[i];
          const obj: Record<string, unknown> = {};
          for (const col of selectedColumns) {
            obj[col] = (row as any)[col];
          }
          res.write(JSON.stringify(obj) + (i < data.length - 1 ? ',' : ''));
        }
        res.write(`],"columns":${JSON.stringify(selectedColumns)},"total":${data.length}}`);
        res.end();
      }
    } catch (err) {
      next(err);
    }
  },
);

export default router;
