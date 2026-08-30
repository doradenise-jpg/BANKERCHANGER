// ============================================================
// BANKERCHANGER — REST Endpoint Group 2: Governance & Disputes
// Addresses Issue #430 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import {
  createProposalGroup2BodySchema,
  castVoteGroup2BodySchema,
  fileDisputeGroup2BodySchema,
  getProposalGroup2ParamsSchema,
  listProposalsGroup2QuerySchema,
  getDisputeGroup2ParamsSchema,
} from '../schemas/governanceGroup2.schemas';
import { validateBody, validateParams, validateQuery } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';

const router = Router();

// Rate limiters
const proposalCreationLimiter = rateLimit({ windowMs: 60_000, max: 10, keyBy: 'userId' });
const votingLimiter = rateLimit({ windowMs: 60_000, max: 30, keyBy: 'userId' });
const disputeLimiter = rateLimit({ windowMs: 60_000, max: 5, keyBy: 'userId' });

/**
 * @swagger
 * tags:
 *   name: Governance Group 2
 *   description: Governance Proposals, Voting Engine, and Market Dispute Resolution (API Group 2)
 */

/**
 * @swagger
 * /api/v2/governance/proposals:
 *   get:
 *     summary: List governance proposals with optional filtering and pagination
 *     tags: [Governance Group 2]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, passed, rejected, executed, cancelled]
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [parameter_change, market_resolution, treasury_allocation, oracle_whitelist, emergency_action]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Paginated list of proposals
 */
router.get(
  '/proposals',
  validateQuery(listProposalsGroup2QuerySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { status, type, proposer, page, limit, sortBy, sortOrder } = req.query as unknown as {
        status?: string;
        type?: string;
        proposer?: string;
        page: number;
        limit: number;
        sortBy: string;
        sortOrder: string;
      };

      const conditions: string[] = [];
      const values: unknown[] = [];
      let paramIdx = 1;

      if (status) {
        conditions.push(`status = $${paramIdx++}`);
        values.push(status);
      }
      if (type) {
        conditions.push(`proposal_type = $${paramIdx++}`);
        values.push(type);
      }
      if (proposer) {
        conditions.push(`proposer = $${paramIdx++}`);
        values.push(proposer);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const offset = (page - 1) * limit;

      const allowedSortColumns: Record<string, string> = {
        created_at: 'created_at',
        expires_at: 'expires_at',
        votes_for: 'votes_for',
        votes_against: 'votes_against',
      };
      const sortCol = allowedSortColumns[sortBy] || 'created_at';
      const sortDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      const countQuery = `SELECT COUNT(*) FROM governance_proposals ${whereClause}`;
      const countRes = await pool.query(countQuery, values);
      const total = parseInt(countRes.rows[0]?.count || '0', 10);

      const listQuery = `
        SELECT id, title, description, proposal_type, target_address, status, proposer,
               votes_for, votes_against, votes_abstain, quorum_bps, expires_at, created_at
        FROM governance_proposals
        ${whereClause}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}
      `;
      values.push(limit, offset);

      const listRes = await pool.query(listQuery, values);

      res.status(200).json({
        success: true,
        data: listRes.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 1,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/governance/proposals/{id}:
 *   get:
 *     summary: Retrieve single governance proposal by ID with vote tallies
 *     tags: [Governance Group 2]
 */
router.get(
  '/proposals/:id',
  validateParams(getProposalGroup2ParamsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `SELECT id, title, description, proposal_type, target_address, parameters,
                status, proposer, votes_for, votes_against, votes_abstain, quorum_bps,
                expires_at, executed_at, created_at
         FROM governance_proposals
         WHERE id = $1 LIMIT 1`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new AppError(404, 'Governance proposal not found');
      }

      res.status(200).json({
        success: true,
        data: result.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/governance/proposals:
 *   post:
 *     summary: Create a new governance proposal
 *     tags: [Governance Group 2]
 *     security:
 *       - BearerAuth: []
 */
router.post(
  '/proposals',
  requireAuth,
  proposalCreationLimiter,
  validateBody(createProposalGroup2BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const {
        title,
        description,
        proposal_type,
        target_address,
        parameters,
        voting_period_hours,
        quorum_bps,
      } = req.body;

      const expiresAt = new Date(Date.now() + voting_period_hours * 3600_000);

      const insertRes = await pool.query(
        `INSERT INTO governance_proposals
         (title, description, proposal_type, target_address, parameters, status, proposer,
          votes_for, votes_against, votes_abstain, quorum_bps, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, 0, 0, 0, $7, $8, NOW())
         RETURNING *`,
        [
          title,
          description,
          proposal_type,
          target_address || null,
          parameters ? JSON.stringify(parameters) : null,
          userId,
          quorum_bps,
          expiresAt,
        ]
      );

      res.status(201).json({
        success: true,
        message: 'Governance proposal created successfully',
        data: insertRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/governance/proposals/{id}/vote:
 *   post:
 *     summary: Cast a vote on an active governance proposal
 *     tags: [Governance Group 2]
 *     security:
 *       - BearerAuth: []
 */
router.post(
  '/proposals/:id/vote',
  requireAuth,
  votingLimiter,
  validateParams(getProposalGroup2ParamsSchema),
  validateBody(castVoteGroup2BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { id } = req.params;
      const { vote, voting_power, reason } = req.body;

      // Verify proposal status and expiration
      const proposalRes = await pool.query(
        'SELECT status, expires_at FROM governance_proposals WHERE id = $1 LIMIT 1',
        [id]
      );

      if (proposalRes.rows.length === 0) {
        throw new AppError(404, 'Governance proposal not found');
      }

      const proposal = proposalRes.rows[0];
      if (proposal.status !== 'active') {
        throw new AppError(400, 'Proposal is not active for voting');
      }
      if (new Date(proposal.expires_at) <= new Date()) {
        throw new AppError(400, 'Proposal voting period has expired');
      }

      // Check if user has already voted
      const existingVote = await pool.query(
        'SELECT id FROM proposal_votes WHERE proposal_id = $1 AND voter = $2 LIMIT 1',
        [id, userId]
      );

      if (existingVote.rows.length > 0) {
        throw new AppError(409, 'Voter has already cast a ballot on this proposal');
      }

      const powerInt = BigInt(voting_power);

      // Record vote and update tallies atomically
      await pool.query(
        `INSERT INTO proposal_votes (proposal_id, voter, vote, voting_power, reason, cast_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [id, userId, vote, voting_power, reason || null]
      );

      const voteColumn =
        vote === 'for' ? 'votes_for' : vote === 'against' ? 'votes_against' : 'votes_abstain';

      await pool.query(
        `UPDATE governance_proposals
         SET ${voteColumn} = ${voteColumn} + $1
         WHERE id = $2`,
        [powerInt.toString(), id]
      );

      res.status(200).json({
        success: true,
        message: 'Vote cast successfully',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/governance/proposals/{id}/execute:
 *   post:
 *     summary: Execute a passed proposal (Admin / Governance caller)
 *     tags: [Governance Group 2]
 *     security:
 *       - BearerAuth: []
 */
router.post(
  '/proposals/:id/execute',
  requireAdminJwt,
  validateParams(getProposalGroup2ParamsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;

      const proposalRes = await pool.query(
        'SELECT * FROM governance_proposals WHERE id = $1 LIMIT 1',
        [id]
      );

      if (proposalRes.rows.length === 0) {
        throw new AppError(404, 'Governance proposal not found');
      }

      const proposal = proposalRes.rows[0];
      if (proposal.status !== 'passed') {
        throw new AppError(400, `Cannot execute proposal with status: ${proposal.status}`);
      }

      await pool.query(
        "UPDATE governance_proposals SET status = 'executed', executed_at = NOW() WHERE id = $1",
        [id]
      );

      res.status(200).json({
        success: true,
        message: 'Proposal executed successfully',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/governance/disputes:
 *   post:
 *     summary: File a dispute against a contested market resolution
 *     tags: [Governance Group 2]
 *     security:
 *       - BearerAuth: []
 */
router.post(
  '/disputes',
  requireAuth,
  disputeLimiter,
  validateBody(fileDisputeGroup2BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { market_id, reason, proposed_outcome, evidence_url, bond_amount } = req.body;

      const marketRes = await pool.query(
        'SELECT id, status FROM markets WHERE id = $1 LIMIT 1',
        [market_id]
      );

      if (marketRes.rows.length === 0) {
        throw new AppError(404, 'Market not found');
      }

      const insertRes = await pool.query(
        `INSERT INTO market_disputes
         (market_id, disputant, reason, proposed_outcome, evidence_url, bond_amount, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
         RETURNING *`,
        [market_id, userId, reason, proposed_outcome, evidence_url || null, bond_amount]
      );

      res.status(201).json({
        success: true,
        message: 'Dispute filed successfully',
        data: insertRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/governance/disputes/{marketId}:
 *   get:
 *     summary: Get dispute details and status for a given market
 *     tags: [Governance Group 2]
 */
router.get(
  '/disputes/:marketId',
  validateParams(getDisputeGroup2ParamsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { marketId } = req.params;

      const disputeRes = await pool.query(
        'SELECT * FROM market_disputes WHERE market_id = $1 ORDER BY created_at DESC',
        [marketId]
      );

      res.status(200).json({
        success: true,
        data: disputeRes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
