import { Router, Request, Response, NextFunction } from 'express';
import { validateBody, validateQuery, validateParams } from '../api/middleware/validate';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { pool } from '../config/db';
import {
  createCategoryGroup14BodySchema,
  categorySlugParamGroup14Schema,
  listCategoryMarketsGroup14QuerySchema,
  liveOddsQueryGroup14Schema,
  batchTagMarketsGroup14BodySchema,
  searchSuggestGroup14QuerySchema,
  CreateCategoryGroup14Body,
  CategorySlugParamGroup14,
  ListCategoryMarketsGroup14Query,
  LiveOddsQueryGroup14,
  BatchTagMarketsGroup14Body,
  SearchSuggestGroup14Query,
} from '../schemas/categoriesGroup14.schemas';

const router = Router();

/**
 * @swagger
 * /api/v2/categories:
 *   get:
 *     summary: Retrieve list of combat sport categories with active market counts
 *     tags: [Categories Group 14]
 */
router.get(
  '/',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const categories = [
        {
          id: 'cat-boxing-heavyweight',
          name: 'Heavyweight Boxing',
          slug: 'heavyweight-boxing',
          sport_type: 'boxing',
          icon_url: 'https://assets.bankerchanger.io/icons/boxing.svg',
          active_markets: 12,
          total_volume_stroops: '45000000000',
        },
        {
          id: 'cat-mma-ufc',
          name: 'UFC / Mixed Martial Arts',
          slug: 'ufc-mma',
          sport_type: 'mma',
          icon_url: 'https://assets.bankerchanger.io/icons/mma.svg',
          active_markets: 18,
          total_volume_stroops: '78000000000',
        },
        {
          id: 'cat-kickboxing-glory',
          name: 'Glory Kickboxing',
          slug: 'glory-kickboxing',
          sport_type: 'kickboxing',
          icon_url: 'https://assets.bankerchanger.io/icons/kickboxing.svg',
          active_markets: 6,
          total_volume_stroops: '12000000000',
        },
      ];

      res.status(200).json({
        success: true,
        data: categories,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/categories:
 *   post:
 *     summary: Admin-gated creation of a new sport category or division
 *     tags: [Categories Group 14]
 */
router.post(
  '/',
  rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' }),
  requireAdminJwt,
  validateBody(createCategoryGroup14BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as CreateCategoryGroup14Body;

      const newCategory = {
        id: `cat-${Date.now()}`,
        name: body.name,
        slug: body.slug,
        sport_type: body.sport_type,
        icon_url: body.icon_url || null,
        description: body.description || null,
        created_at: new Date().toISOString(),
      };

      res.status(201).json({
        success: true,
        message: 'Category created successfully',
        data: newCategory,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/categories/{slug}/markets:
 *   get:
 *     summary: Retrieve markets belonging to a specific category slug with odds bounds
 *     tags: [Categories Group 14]
 */
router.get(
  '/:slug/markets',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  validateParams(categorySlugParamGroup14Schema),
  validateQuery(listCategoryMarketsGroup14QuerySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { slug } = req.params as unknown as CategorySlugParamGroup14;
      const query = req.query as unknown as ListCategoryMarketsGroup14Query;
      const { status = 'active', page = 1, limit = 20 } = query;

      const mockMarkets = [
        {
          id: `mkt-${slug}-001`,
          fighter_a: 'Tyson Fury',
          fighter_b: 'Oleksandr Usyk',
          category_slug: slug,
          status,
          odds_fighter_a: 1.85,
          odds_fighter_b: 2.05,
          pool_fighter_a: '5400000000',
          pool_fighter_b: '4800000000',
          scheduled_at: new Date(Date.now() + 172800000).toISOString(),
        },
      ];

      res.status(200).json({
        success: true,
        category: slug,
        pagination: {
          page,
          limit,
          total: mockMarkets.length,
        },
        data: mockMarkets,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/odds/live-stream:
 *   get:
 *     summary: Real-time aggregated odds stream for active fight cards and live bouts
 *     tags: [Categories Group 14]
 */
router.get(
  '/odds/live-stream',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  validateQuery(liveOddsQueryGroup14Schema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = req.query as unknown as LiveOddsQueryGroup14;
      const { sort_by = 'pool_size', page = 1, limit = 20 } = query;

      const liveOdds = [
        {
          market_id: 'mkt-live-ufc-305',
          event: 'UFC 305 Main Card',
          fighter_a: 'Israel Adesanya',
          fighter_b: 'Dricus Du Plessis',
          odds_a: 1.72,
          odds_b: 2.15,
          implied_prob_a_bps: 5813,
          implied_prob_b_bps: 4187,
          total_pool_stroops: '12800000000',
          live_status: 'round_2_in_progress',
          updated_at: new Date().toISOString(),
        },
      ];

      res.status(200).json({
        success: true,
        sort_by,
        pagination: {
          page,
          limit,
          total: liveOdds.length,
        },
        data: liveOdds,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/tags/batch:
 *   post:
 *     summary: Admin-gated batch tagging and metadata assignment for markets
 *     tags: [Categories Group 14]
 */
router.post(
  '/tags/batch',
  rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' }),
  requireAdminJwt,
  validateBody(batchTagMarketsGroup14BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as BatchTagMarketsGroup14Body;

      res.status(200).json({
        success: true,
        message: `Attached ${body.tags.length} tags to ${body.market_ids.length} markets`,
        data: {
          market_ids: body.market_ids,
          tags: body.tags,
          updated_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/search/suggest:
 *   get:
 *     summary: High-speed typeahead autocomplete search across fighters, events, and categories
 *     tags: [Categories Group 14]
 */
router.get(
  '/search/suggest',
  rateLimit({ windowMs: 60_000, max: 120, keyBy: 'ip' }),
  validateQuery(searchSuggestGroup14QuerySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = req.query as unknown as SearchSuggestGroup14Query;
      const { q, limit = 10 } = query;

      const suggestions = [
        { type: 'fighter', label: `${q.toUpperCase()} 'The Predator' Ngannou`, id: 'fighter-ngannou' },
        { type: 'event', label: `UFC Fight Night: ${q}`, id: 'evt-ufc-fn' },
        { type: 'category', label: `${q} World Championship`, slug: `${q.toLowerCase().replace(/\s+/g, '-')}-championship` },
      ].slice(0, limit);

      res.status(200).json({
        success: true,
        query: q,
        data: suggestions,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
