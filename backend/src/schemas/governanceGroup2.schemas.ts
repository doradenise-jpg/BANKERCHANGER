import { z } from 'zod';

export const proposalTypeEnum = z.enum([
  'parameter_change',
  'market_resolution',
  'treasury_allocation',
  'oracle_whitelist',
  'emergency_action',
]);

export const proposalStatusEnum = z.enum([
  'active',
  'passed',
  'rejected',
  'executed',
  'cancelled',
]);

export const voteChoiceEnum = z.enum(['for', 'against', 'abstain']);

export const disputeOutcomeEnum = z.enum(['fighter_a', 'fighter_b', 'draw', 'cancelled']);

const stellarAddressOrContractRegex = /^[GC][A-Z2-7]{55}$/;

export const createProposalGroup2BodySchema = z.object({
  title: z
    .string()
    .trim()
    .min(5, 'Title must be at least 5 characters long')
    .max(200, 'Title cannot exceed 200 characters'),
  description: z
    .string()
    .trim()
    .min(20, 'Description must be at least 20 characters long')
    .max(5000, 'Description cannot exceed 5000 characters'),
  proposal_type: proposalTypeEnum,
  target_address: z
    .string()
    .trim()
    .regex(stellarAddressOrContractRegex, 'Target address must be a valid Stellar account or contract ID')
    .optional(),
  parameters: z.record(z.unknown()).optional(),
  voting_period_hours: z
    .number()
    .int()
    .min(24, 'Voting period must be at least 24 hours')
    .max(720, 'Voting period cannot exceed 720 hours (30 days)')
    .default(72),
  quorum_bps: z
    .number()
    .int()
    .min(100, 'Quorum must be at least 100 bps (1%)')
    .max(10000, 'Quorum cannot exceed 10000 bps (100%)')
    .default(1000),
});

export const castVoteGroup2BodySchema = z.object({
  vote: voteChoiceEnum,
  voting_power: z
    .string()
    .trim()
    .regex(/^\d+$/, 'Voting power must be a positive integer stroop string'),
  reason: z.string().trim().max(1000, 'Vote reason cannot exceed 1000 characters').optional(),
});

export const fileDisputeGroup2BodySchema = z.object({
  market_id: z.string().trim().min(1, 'Market ID is required'),
  reason: z
    .string()
    .trim()
    .min(10, 'Dispute reason must be at least 10 characters long')
    .max(1000, 'Dispute reason cannot exceed 1000 characters'),
  proposed_outcome: disputeOutcomeEnum,
  evidence_url: z.string().trim().url('Evidence URL must be a valid URL').optional(),
  bond_amount: z
    .string()
    .trim()
    .regex(/^\d+$/, 'Bond amount must be a numeric stroop string'),
});

export const getProposalGroup2ParamsSchema = z.object({
  id: z.string().trim().min(1, 'Proposal ID is required'),
});

export const listProposalsGroup2QuerySchema = z.object({
  status: proposalStatusEnum.optional(),
  type: proposalTypeEnum.optional(),
  proposer: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['created_at', 'expires_at', 'votes_for', 'votes_against']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const getDisputeGroup2ParamsSchema = z.object({
  marketId: z.string().trim().min(1, 'Market ID is required'),
});
