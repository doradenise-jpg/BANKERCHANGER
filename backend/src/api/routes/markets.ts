import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { MarketService } from '../../services/MarketService';

const router = Router();

const listMarketsQuerySchema = z.object({
  status: z
    .enum(['open', 'locked', 'resolved', 'cancelled'], {
      errorMap: () => ({
        message: 'status must be one of: open, locked, resolved, cancelled',
      }),
    })
    .optional(),
  weight_class: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * GET /api/markets
 * List markets with optional filtering and pagination.
 */
router.get('/', async (req: Request, res: Response) => {
  const parsed = listMarketsQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Validation error',
      details: parsed.error.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  const { status, weight_class, page, limit } = parsed.data;

  try {
    const { markets, total } = await MarketService.getMarkets({
      status,
      weight_class,
      page,
      limit,
    });

    return res.status(200).json({ markets, total, page, limit });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch markets',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
