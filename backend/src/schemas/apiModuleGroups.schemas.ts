import { z } from 'zod';

// --- Endpoint Group 19: Wallets & Payments ---

export const listWalletsQuery = z.object({
  userId: z.string().uuid().optional(),
  currency: z.string().max(8).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const walletIdParam = z.object({
  walletId: z.string().uuid(),
});

export const walletTransactionsQuery = z.object({
  type: z.enum(['deposit', 'withdrawal', 'bet', 'claim', 'refund']).optional(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const depositBody = z.object({
  walletId: z.string().uuid(),
  currency: z.string().min(3).max(8),
  amount: z.coerce.number().positive().max(1_000_000_000),
  paymentMethod: z.enum(['card', 'bank_transfer', 'crypto', 'stellar']),
  referenceId: z.string().max(100).optional(),
});

export const withdrawBody = z.object({
  walletId: z.string().uuid(),
  currency: z.string().min(3).max(8),
  amount: z.coerce.number().positive().max(1_000_000_000),
  destination: z.string().min(1).max(256),
  note: z.string().max(500).optional(),
});

// --- Endpoint Group 20: Market Management & Escrow ---

export const listMarketsQuery = z.object({
  sport: z.string().max(50).optional(),
  status: z.enum(['open', 'locked', 'resolved', 'cancelled']).optional(),
  marketType: z.enum(['moneyline', 'spread', 'total', 'parlay']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const marketIdParam = z.object({
  marketId: z.string().uuid(),
});

export const escrowHoldBody = z.object({
  marketId: z.string().uuid(),
  amountUsd: z.coerce.number().positive().max(1_000_000_000),
  holdRef: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export const closeMarketBody = z.object({
  reason: z.enum([
    'no_contest',
    'rule_change',
    'regulatory',
    'insufficient_liquidity',
    'technical_error',
    'fraud',
  ]),
  cancelBets: z.boolean().default(true),
});

export const settleEscrowBody = z.object({
  settleAmountUsd: z.coerce.number().nonnegative().max(1_000_000_000),
  recipient: z.string().min(1).max(256),
  note: z.string().max(500).optional(),
});