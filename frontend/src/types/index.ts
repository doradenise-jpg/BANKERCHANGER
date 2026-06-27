// ============================================================
// BOXMEOUT — Shared Frontend Types
// ============================================================
// NOTE: Market, Bet, Portfolio, MarketStats are generated from
// the backend OpenAPI spec (backend/openapi.yaml).
// Run `npm run generate:types` to regenerate.
// ============================================================

import type { components } from './api';

type $Required<T> = { [K in keyof T]-?: T[K] };
type ApiMarket = $Required<components['schemas']['Market']>;
type ApiBet = $Required<components['schemas']['Bet']>;

export interface Market extends ApiMarket {
  /** Implied probability in basis points (0–10000) */
  odds_a: number;
  odds_b: number;
  odds_draw: number;
  /** Oracle address that submitted result (if resolved) */
  oracle_address?: string;
  /** Transaction hash of resolution (if resolved) */
  resolution_tx_hash?: string;
}

export type MarketStatus = ApiMarket['status'];
export type OutcomeString = NonNullable<ApiMarket['outcome']>;
export type BetSide = NonNullable<ApiBet['side']>;

export type Bet = ApiBet;
export type Portfolio = $Required<components['schemas']['Portfolio']>;
export type MarketStats = $Required<components['schemas']['MarketStats']>;

export interface TxStatus {
  hash: string | null;
  status: 'idle' | 'signing' | 'broadcasting' | 'confirming' | 'success' | 'error';
  error: string | null;
}

/** Pending states that show a spinner */
export const TX_PENDING_STATES = ['signing', 'broadcasting', 'confirming'] as const;
export type TxPendingState = (typeof TX_PENDING_STATES)[number];

// ─── Governance ──────────────────────────────────────────────────────────────

export type ProposalType = 
  | 'fee_rate' 
  | 'add_token' 
  | 'remove_token' 
  | 'max_discount_rate';

export interface CreateProposalParams {
  type: ProposalType;
  /** Depending on the type, this could be a number (bps) or a string (address) */
  value: string | number;
  description: string;
}

export type ProposalStatus = 'Active' | 'Passed' | 'Failed' | 'Executed';

export type VoteType = 'for' | 'against' | 'abstain';

export interface Proposal {
  id: string;
  type: ProposalType;
  value: string | number;
  description: string;
  status: ProposalStatus;
  proposer: string;
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  createdAt: string; // ISO 8601 timestamp
  expiresAt: string; // ISO 8601 timestamp
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export type InvoiceStatus = 'Pending' | 'Funded' | 'Paid';

export interface Invoice {
  id: string;
  freelancer: string;
  payer: string;
  amount: number;
  dueDate: string; // ISO 8601 timestamp
  status: InvoiceStatus;
}
