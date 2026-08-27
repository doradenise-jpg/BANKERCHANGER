// ============================================================
// BANKERCHANGER — REST Endpoint Group 6: Users & KYC
// Addresses Issue #434 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import {
  updateProfileGroup6BodySchema,
  submitKycGroup6BodySchema,
  updateRoleGroup6ParamsSchema,
  updateRoleGroup6BodySchema,
  listUsersGroup6QuerySchema,
} from '../schemas/userGroup6.schemas';
import { validateBody, validateParams, validateQuery } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';

const router = Router();

// Per-user profile update rate limiter (20 requests per minute)
const profileUpdateLimiter = rateLimit({ windowMs: 60_000, max: 20, keyBy: 'userId' });

/**
 * @swagger
 * tags:
 *   name: Users Group 6
 *   description: User Profiles, KYC Status & Role-Based Access Control (API Group 6)
 */

/**
 * @swagger
 * /api/v2/users/me:
 *   get:
 *     summary: Retrieve current authenticated user profile
 *     tags: [Users Group 6]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile data
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/me',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId;
      const userRes = await pool.query(
        'SELECT id, username, email, role, kyc_tier, created_at, updated_at FROM users WHERE id = $1',
        [userId]
      );

      if (userRes.rows.length === 0) {
        throw AppError.notFound('User not found');
      }

      res.status(200).json({
        success: true,
        data: userRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/users/me:
 *   patch:
 *     summary: Update profile for current authenticated user
 *     tags: [Users Group 6]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               avatar_url:
 *                 type: string
 *               notifications_enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *       401:
 *         description: Unauthorized
 *       422:
 *         description: Validation error
 */
router.patch(
  '/me',
  requireAuth,
  profileUpdateLimiter,
  validateBody(updateProfileGroup6BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId;
      const { username, email, avatar_url, notifications_enabled } = req.body;

      const setClauses: string[] = ['updated_at = NOW()'];
      const values: unknown[] = [userId];

      if (username !== undefined) {
        values.push(username);
        setClauses.push(`username = $${values.length}`);
      }

      if (email !== undefined) {
        values.push(email);
        setClauses.push(`email = $${values.length}`);
      }

      if (avatar_url !== undefined) {
        values.push(avatar_url);
        setClauses.push(`avatar_url = $${values.length}`);
      }

      if (notifications_enabled !== undefined) {
        values.push(notifications_enabled);
        setClauses.push(`notifications_enabled = $${values.length}`);
      }

      const updateRes = await pool.query(
        `UPDATE users SET ${setClauses.join(', ')} WHERE id = $1 RETURNING id, username, email, role, kyc_tier, updated_at`,
        values
      );

      if (updateRes.rows.length === 0) {
        throw AppError.notFound('User not found');
      }

      res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        data: updateRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/users/kyc/submit:
 *   post:
 *     summary: Submit KYC document verification request
 *     tags: [Users Group 6]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [full_name, country_code, document_type, document_hash, requested_tier]
 *     responses:
 *       201:
 *         description: KYC submission accepted
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/kyc/submit',
  requireAuth,
  validateBody(submitKycGroup6BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId;
      const { full_name, country_code, document_type, document_hash, requested_tier } = req.body;

      const kycRes = await pool.query(
        `INSERT INTO kyc_verifications (
          user_id, full_name, country_code, document_type,
          document_hash, requested_tier, status, submitted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
        RETURNING *`,
        [userId, full_name, country_code, document_type, document_hash, requested_tier]
      );

      res.status(201).json({
        success: true,
        message: 'KYC submission received and queued for automated verification',
        data: kycRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/users/{id}/role:
 *   patch:
 *     summary: Update user role (Admin only)
 *     tags: [Users Group 6]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *     responses:
 *       200:
 *         description: Role updated successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 */
router.patch(
  '/:id/role',
  requireAdminJwt,
  validateParams(updateRoleGroup6ParamsSchema),
  validateBody(updateRoleGroup6BodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { role, reason } = req.body;

      const updateRes = await pool.query(
        `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, email, role, updated_at`,
        [role, id]
      );

      if (updateRes.rows.length === 0) {
        throw AppError.notFound(`User with id '${id}' not found`);
      }

      res.status(200).json({
        success: true,
        message: `User role updated to ${role}: ${reason}`,
        data: updateRes.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/users:
 *   get:
 *     summary: List users with role/KYC filtering (Admin only)
 *     tags: [Users Group 6]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [user, moderator, admin, oracle]
 *       - in: query
 *         name: kyc_tier
 *         schema:
 *           type: string
 *           enum: [tier_0, tier_1, tier_2, tier_3]
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
 *         description: Paginated users list
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/',
  requireAdminJwt,
  validateQuery(listUsersGroup6QuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query as unknown as {
        role?: string;
        kyc_tier?: string;
        search?: string;
        page: number;
        limit: number;
      };

      const page = query.page || 1;
      const limit = query.limit || 20;
      const offset = (page - 1) * limit;

      const whereClauses: string[] = [];
      const values: unknown[] = [];

      if (query.role) {
        values.push(query.role);
        whereClauses.push(`role = $${values.length}`);
      }

      if (query.kyc_tier) {
        values.push(query.kyc_tier);
        whereClauses.push(`kyc_tier = $${values.length}`);
      }

      if (query.search) {
        values.push(`%${query.search}%`);
        whereClauses.push(`(username ILIKE $${values.length} OR email ILIKE $${values.length})`);
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      const countRes = await pool.query(`SELECT COUNT(*) as count FROM users ${whereSql}`, values);
      const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

      const usersRes = await pool.query(
        `SELECT id, username, email, role, kyc_tier, created_at, updated_at FROM users ${whereSql} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      );

      res.status(200).json({
        success: true,
        data: {
          users: usersRes.rows,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
