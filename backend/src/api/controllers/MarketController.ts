// ============================================================
// BANKERCHANGER — Market Controller
// Handles HTTP requests for market-related endpoints.
// ============================================================

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';
import { AppError } from '../../utils/AppError';
import { ERROR_CODES } from '../../constants/errorCodes';
import { validateQuery } from '../../middleware/validation.middleware';
import * as MarketService from '../../services/MarketService';
import * as OracleService from '../../oracle/OracleService';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Issue #18 — listMarkets
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['open', 'locked', 'resolved', 'cancelled', 'disputed'] as const;
const MAX_LIMIT = 200;

const VALID_WEIGHT_CLASSES = [
  'Heavyweight',
  'Light Heavyweight',
  'Super Middleweight',
  'Middleweight',
  'Super Welterweight',
  'Welterweight',
  'Super Lightweight',
  'Lightweight',
  'Super Featherweight',
  'Featherweight',
  'Super Bantamweight',
  'Bantamweight',
  'Super Flyweight',
  'Flyweight',
  'Minimumweight',
] as const;

const listMarketsQuerySchema = z.object({
  status: z
    .enum(VALID_STATUSES, {
      errorMap: () => ({ message: `status must be one of: ${VALID_STATUSES.join(', ')}` }),
    })
    .optional(),
  weight_class: z
    .enum(VALID_WEIGHT_CLASSES)
    .optional(),
  fighter: z.string().min(1).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sort: z.enum(['date_asc', 'date_desc', 'pool_desc']).default('date_asc'),
  page: z.coerce.number().int().min(1, { message: 'page must be an integer ≥ 1' }).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1, { message: `limit must be between 1 and ${MAX_LIMIT}` })
    .max(MAX_LIMIT, { message: `limit must be between 1 and ${MAX_LIMIT}` })
    .default(20),
});

export const listMarketsValidation = validateQuery(listMarketsQuerySchema);

/**
 * GET /api/markets
 * Query params: status, weight_class, page (default 1), limit (default 20)
 *
 * Returns paginated market list.
 * Validates query params with Zod before passing to MarketService.
 * Responds 400 on invalid params, 200 with { markets, total, hasNextPage, page, limit }.
 */
export async function listMarkets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = listMarketsQuerySchema.parse(req.query);
    const { status, weight_class, fighter, dateFrom, dateTo, sort, page, limit } = parsed;
    const { markets, total, hasNextPage } = await MarketService.getMarkets(
      { status, weight_class, fighter, dateFrom, dateTo, sort },
      { page, limit },
    );
    res.status(200).json({ markets, total, hasNextPage, page, limit });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/recent-markets
 *
 * Returns summary information for the ten most recently created markets.
 */
export async function getRecentMarkets(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const markets = await MarketService.getRecentMarkets();
    res.status(200).json(markets);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/markets/:market_id
 *
 * Returns full market detail including current odds.
 * Responds 404 if market_id not found, 200 with Market object.
 */
export async function getMarket(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { market_id } = req.params;
    const market = await MarketService.getMarketById(market_id);
    res.status(200).json(market);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      res.status(404).json({ error: 'Market not found' });
      return;
    }
    next(err);
  }
}

/**
 * GET /api/markets/:market_id/bets
 * Query params: address (optional — filter to one bettor)
 *
 * Returns all bets for a market.
 * Returns an empty array when the market has no bets, and responds 400 for an
 * invalid Stellar address.
 */
export async function getMarketBets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { market_id } = req.params;
    const address = req.query.address;

    if (address !== undefined) {
      if (typeof address !== 'string' || !StrKey.isValidEd25519PublicKey(address)) {
        res.status(400).json({ error: 'Invalid Stellar address format' });
        return;
      }
    }

    const bets = await MarketService.getBetsByMarket(market_id, address);
    res.status(200).json(bets);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/markets/:market_id/stats
 *
 * Returns market volume, live odds, top bettors, and betting distribution.
 * Statistics are cached for 60 seconds.
 */
export async function getMarketStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { market_id } = req.params;
    const stats = await MarketService.getMarketStats(market_id);
    res.status(200).json(stats);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/markets/:market_id/odds
 *
 * Returns parimutuel odds for all three outcomes (fighter_a, fighter_b, draw).
 * Each outcome includes the multiplier (net payout per unit staked) and
 * implied probability (as a percentage).
 * Responds 404 if market not found, 200 with AllOutcomeOdds.
 */
const MARKET_ODDS_OUTCOMES = ['fighter_a', 'fighter_b', 'draw'] as const;

export async function getMarketOdds(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { market_id } = req.params;
    const outcome = req.query.outcome as string | undefined;

    if (outcome && !MARKET_ODDS_OUTCOMES.includes(outcome as typeof MARKET_ODDS_OUTCOMES[number])) {
      res.status(400).json({ error: `Invalid outcome. Must be one of: ${MARKET_ODDS_OUTCOMES.join(', ')}` });
      return;
    }

    if (outcome) {
      const odds = await MarketService.calculateSingleOutcomeOdds(market_id, outcome as 'fighter_a' | 'fighter_b' | 'draw');
      res.status(200).json(odds);
    } else {
      const odds = await MarketService.calculateOutcomeOdds(market_id);
      res.status(200).json(odds);
    }
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      return next(err);
    }
    next(err);
  }
}

/**
 * GET /api/markets/:market_id/live-odds
 *
 * Returns uncached odds computed from the current market pools.
 */
export async function getLiveMarketOdds(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  res.set('Cache-Control', 'no-store');
  try {
    const { market_id } = req.params;
    const odds = await MarketService.getLiveMarketOdds(market_id);
    res.status(200).json(odds);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/markets/:market_id/odds/stream
 *
 * Server-Sent Events stream of live parimutuel odds for a market.
 * Pushes an update immediately on connect, then every 5 seconds while the
 * market is open. Closes automatically when the market reaches a terminal
 * status (resolved / cancelled).
 */
export async function streamMarketOdds(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { market_id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const TERMINAL = new Set(['resolved', 'cancelled']);
  const INTERVAL_MS = 5_000;

  const push = async (): Promise<boolean> => {
    try {
      const market = await MarketService.getMarketById(market_id);
      const odds = await MarketService.calculateOutcomeOdds(market_id);
      res.write(`data: ${JSON.stringify(odds)}\n\n`);
      return TERMINAL.has((market as any).status ?? '');
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
      return true; // close on error
    }
  };

  const shouldClose = await push();
  if (shouldClose) {
    res.end();
    return;
  }

  const timer = setInterval(async () => {
    const done = await push();
    if (done) {
      clearInterval(timer);
      res.end();
    }
  }, INTERVAL_MS);

  req.on('close', () => {
    clearInterval(timer);
  });
}
