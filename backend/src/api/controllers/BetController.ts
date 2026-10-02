// ============================================================
// BANKERCHANGER — Bet Controller
// Claim endpoints for winning bettors.
// ============================================================

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';
import * as BetService from '../../services/BetService';
import * as MarketService from '../../services/MarketService';
import { AppError } from '../../utils/AppError';
import { ERROR_CODES } from '../../constants/errorCodes';

const claimBodySchema = z.object({
  market_id: z.string().min(1, 'market_id is required'),
  bettor_address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format for bettor_address',
    }),
  token_address: z
    .string()
    .refine((v) => StrKey.isValidEd25519PublicKey(v), {
      message: 'Invalid Stellar address format for token_address',
    }),
});

/**
 * POST /api/claims
 * Body: { market_id, bettor_address, token_address }
 *
 * Submits a claim_winnings transaction for a winning bettor.
 * Returns the transaction hash. The DB is updated asynchronously
 * by the indexer when it picks up the WinningsClaimed event.
 */
export async function claimWinnings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = claimBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      res.status(400).json({ errors });
      return;
    }

    const { market_id, bettor_address, token_address } = parsed.data;
    const tx_hash = await BetService.claimWinnings(market_id, bettor_address, token_address);
    res.status(200).json({ tx_hash });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/bets/:bettor_address/stats
 *
 * Returns aggregate stats for a Stellar address:
 * total_wagered_xlm, total_winnings_xlm, total_bets, win_rate, favorite_fighter.
 * Cached 60s. Returns zeroed stats (not 404) for addresses with no bets.
 */
export async function getBettorStats(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { bettor_address } = req.params;

    if (!StrKey.isValidEd25519PublicKey(bettor_address)) {
      throw AppError.badRequest(
        'Invalid Stellar address format',
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const stats = await MarketService.getBettorStats(bettor_address);
    res.status(200).json(stats);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 400) {
      return next(err);
    }
    next(err);
  }
}

/**
 * GET /api/bets/:bettor_address
 *
 * Returns paginated bets placed by a given Stellar address.
 * Validates the Stellar address format and returns 400 Bad Request if invalid.
 */
export async function getBetsByAddress(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { bettor_address } = req.params;
    const legacyPage = req.query.page !== undefined;
    const legacyOffset = req.query.offset !== undefined ? parseInt(req.query.offset as string, 10) : undefined;
    const page = legacyPage ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit !== undefined ? parseInt(req.query.limit as string, 10) : 50;
    const cursor = req.query.cursor as string | undefined;
    const cursorMode = cursor !== undefined || (!legacyPage && legacyOffset === undefined);

    // Validate Stellar address format early and return 400 (not 500) for invalid addresses
    try {
      if (!StrKey.isValidEd25519PublicKey(bettor_address)) {
        throw AppError.badRequest(
          'Invalid Stellar address format',
          ERROR_CODES.INVALID_REQUEST
        );
      }
    } catch (validationErr) {
      // If validation error is already an AppError, rethrow it
      if (validationErr instanceof AppError) {
        throw validationErr;
      }
      // Otherwise wrap any validation exception as a 400 Bad Request
      throw AppError.badRequest(
        'Invalid Stellar address format',
        ERROR_CODES.INVALID_REQUEST
      );
    }

    const result = await BetService.fetchBetsByAddress(
      bettor_address,
      page,
      limit,
      cursorMode ? cursor ?? '' : null,
      legacyOffset,
    );
    if (cursorMode) {
      res.status(200).json({ bets: result.bets, nextCursor: result.nextCursor, limit });
      return;
    }

    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'Fri, 02 Apr 2027 00:00:00 GMT');
    res.status(200).json({ bets: result.bets, total: result.total, limit, nextCursor: result.nextCursor });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 400) {
      return next(err);
    }
    next(err);
  }
}

/**
 * POST /api/claims/refund
 * Body: { market_id, bettor_address, token_address }
 *
 * Submits a claim_refund transaction for a cancelled market.
 * Returns the transaction hash.
 */
export async function claimRefund(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = claimBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      res.status(400).json({ errors });
      return;
    }

    const { market_id, bettor_address, token_address } = parsed.data;
    const tx_hash = await BetService.claimRefund(market_id, bettor_address, token_address);
    res.status(200).json({ tx_hash });
  } catch (err) {
    next(err);
  }
}
