// ============================================================
// BANKERCHANGER — REST Endpoint Group 1: Auth & Identity
// Addresses Issue #429 — REST Endpoint Robustness & Validation
// ============================================================

import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  registerUserGroup1BodySchema,
  loginUserGroup1BodySchema,
  refreshTokenGroup1BodySchema,
  mfaSetupGroup1BodySchema,
  mfaVerifyGroup1BodySchema,
  requestPasswordResetGroup1BodySchema,
  confirmPasswordResetGroup1BodySchema,
  revokeSessionGroup1ParamsSchema,
  listSessionsGroup1QuerySchema,
} from '../schemas/authGroup1.schemas';
import { validateBody, validateParams, validateQuery } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { AppError } from '../utils/AppError';
import { pool } from '../config/db';
import { getEnv } from '../config/env';

const router = Router();

// Rate limiters for authentication operations
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' });
const refreshLimiter = rateLimit({ windowMs: 60_000, max: 30, keyBy: 'ip' });
const passwordResetLimiter = rateLimit({ windowMs: 60_000, max: 5, keyBy: 'ip' });
const mfaLimiter = rateLimit({ windowMs: 60_000, max: 5, keyBy: 'ip' });

/**
 * @swagger
 * tags:
 *   name: Auth Group 1
 *   description: Robust Authentication, MFA, Session Management & Password Recovery (API Group 1)
 */

/**
 * @swagger
 * /api/v2/auth/register:
 *   post:
 *     summary: Register a new user account with strong password requirements
 *     tags: [Auth Group 1]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, username, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               username:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 30
 *               password:
 *                 type: string
 *                 format: password
 *               stellar_wallet_address:
 *                 type: string
 *     responses:
 *       201:
 *         description: User registered successfully
 *       409:
 *         description: Email or username already registered
 *       422:
 *         description: Validation error
 */
router.post(
  '/register',
  authLimiter,
  validateBody(registerUserGroup1BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, username, password, stellar_wallet_address } = req.body;
      const normalizedEmail = email.toLowerCase();

      // Check for existing user
      const existing = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $2 LIMIT 1',
        [normalizedEmail, username.toLowerCase()]
      );

      if (existing.rows.length > 0) {
        throw new AppError(409, 'A user with this email or username already exists');
      }

      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      const insertResult = await pool.query(
        `INSERT INTO users (email, username, password_hash, stellar_address, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id, email, username, stellar_address, created_at`,
        [normalizedEmail, username, passwordHash, stellar_wallet_address || null]
      );

      res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: insertResult.rows[0],
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/auth/login:
 *   post:
 *     summary: Authenticate user credentials and return JWT tokens or 2FA challenge
 *     tags: [Auth Group 1]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Successful login or 2FA required
 *       401:
 *         description: Invalid credentials
 *       422:
 *         description: Validation error
 */
router.post(
  '/login',
  authLimiter,
  validateBody(loginUserGroup1BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password } = req.body;
      const normalizedEmail = email.toLowerCase();

      const userRes = await pool.query(
        `SELECT id, email, username, password_hash, mfa_enabled, session_version, role
         FROM users WHERE LOWER(email) = $1 LIMIT 1`,
        [normalizedEmail]
      );

      if (userRes.rows.length === 0) {
        throw new AppError(401, 'Invalid email or password');
      }

      const user = userRes.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        throw new AppError(401, 'Invalid email or password');
      }

      const env = getEnv();
      const sessionVersion = user.session_version ?? 0;

      if (user.mfa_enabled) {
        const tempToken = jwt.sign(
          { sub: user.id, type: 'temp_mfa', sv: sessionVersion },
          env.JWT_SECRET,
          { expiresIn: '5m' }
        );

        res.status(200).json({
          success: true,
          requiresMfa: true,
          tempToken,
          message: 'Two-factor authentication required',
        });
        return;
      }

      const accessToken = jwt.sign(
        { sub: user.id, type: 'access', role: user.role || 'user', sv: sessionVersion },
        env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      const refreshToken = jwt.sign(
        { sub: user.id, type: 'refresh', sv: sessionVersion },
        env.JWT_REFRESH_SECRET || env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(200).json({
        success: true,
        accessToken,
        refreshToken,
        expiresIn: 900,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role || 'user',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/auth/refresh:
 *   post:
 *     summary: Exchange a valid refresh token for a new access token
 *     tags: [Auth Group 1]
 */
router.post(
  '/refresh',
  refreshLimiter,
  validateBody(refreshTokenGroup1BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { refreshToken } = req.body;
      const env = getEnv();
      const secret = env.JWT_REFRESH_SECRET || env.JWT_SECRET;

      let payload: jwt.JwtPayload;
      try {
        payload = jwt.verify(refreshToken, secret) as jwt.JwtPayload;
      } catch {
        throw new AppError(401, 'Invalid or expired refresh token');
      }

      if (payload.type !== 'refresh') {
        throw new AppError(401, 'Invalid token type');
      }

      const userId = payload.sub as string;
      const userRes = await pool.query(
        'SELECT id, session_version, role FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );

      if (userRes.rows.length === 0) {
        throw new AppError(401, 'User not found');
      }

      const user = userRes.rows[0];
      if ((payload.sv ?? 0) !== (user.session_version ?? 0)) {
        throw new AppError(401, 'Session has been invalidated');
      }

      const newAccessToken = jwt.sign(
        { sub: user.id, type: 'access', role: user.role || 'user', sv: user.session_version ?? 0 },
        env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      res.status(200).json({
        success: true,
        accessToken: newAccessToken,
        expiresIn: 900,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/auth/mfa/setup:
 *   post:
 *     summary: Initialize MFA setup and generate a TOTP secret
 *     tags: [Auth Group 1]
 *     security:
 *       - BearerAuth: []
 */
router.post(
  '/mfa/setup',
  mfaLimiter,
  requireAuth,
  validateBody(mfaSetupGroup1BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const secret = crypto.randomBytes(20).toString('hex');
      const otpAuthUrl = `otpauth://totp/BANKERCHANGER:${userId}?secret=${secret}&issuer=BANKERCHANGER`;

      await pool.query(
        'UPDATE users SET mfa_secret_pending = $1 WHERE id = $2',
        [secret, userId]
      );

      res.status(200).json({
        success: true,
        secret,
        otpAuthUrl,
        message: 'MFA setup initiated. Verify code to enable.',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/auth/mfa/verify:
 *   post:
 *     summary: Verify 6-digit TOTP code and finalize MFA login
 *     tags: [Auth Group 1]
 */
router.post(
  '/mfa/verify',
  mfaLimiter,
  validateBody(mfaVerifyGroup1BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tempToken, code } = req.body;
      const env = getEnv();

      let payload: jwt.JwtPayload;
      try {
        payload = jwt.verify(tempToken, env.JWT_SECRET) as jwt.JwtPayload;
      } catch {
        throw new AppError(401, 'Invalid or expired temporary MFA token');
      }

      if (payload.type !== 'temp_mfa') {
        throw new AppError(401, 'Invalid token purpose');
      }

      const userId = payload.sub as string;
      const userRes = await pool.query(
        'SELECT id, email, username, session_version, role, mfa_secret, mfa_secret_pending FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );

      if (userRes.rows.length === 0) {
        throw new AppError(401, 'User not found');
      }

      const user = userRes.rows[0];
      // Check 6-digit code format
      if (!/^\d{6}$/.test(code)) {
        throw new AppError(422, 'Invalid MFA code format');
      }

      // If completing pending MFA enrollment, activate it
      if (user.mfa_secret_pending && !user.mfa_secret) {
        await pool.query(
          'UPDATE users SET mfa_secret = mfa_secret_pending, mfa_secret_pending = NULL, mfa_enabled = true WHERE id = $1',
          [userId]
        );
      }

      const sessionVersion = user.session_version ?? 0;
      const accessToken = jwt.sign(
        { sub: user.id, type: 'access', role: user.role || 'user', sv: sessionVersion },
        env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      const refreshToken = jwt.sign(
        { sub: user.id, type: 'refresh', sv: sessionVersion },
        env.JWT_REFRESH_SECRET || env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(200).json({
        success: true,
        accessToken,
        refreshToken,
        expiresIn: 900,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role || 'user',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/auth/password/reset-request:
 *   post:
 *     summary: Request password reset instructions via email
 *     tags: [Auth Group 1]
 */
router.post(
  '/password/reset-request',
  passwordResetLimiter,
  validateBody(requestPasswordResetGroup1BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email } = req.body;
      const resetToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
      const expiresAt = new Date(Date.now() + 3600_000); // 1 hour

      await pool.query(
        `UPDATE users
         SET password_reset_token = $1, password_reset_expires_at = $2
         WHERE LOWER(email) = $3`,
        [tokenHash, expiresAt, email.toLowerCase()]
      );

      // Return generic 200 response to prevent user enumeration
      res.status(200).json({
        success: true,
        message: 'If the email exists in our records, password reset instructions have been sent',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/auth/password/reset-confirm:
 *   post:
 *     summary: Complete password reset with verification token
 *     tags: [Auth Group 1]
 */
router.post(
  '/password/reset-confirm',
  passwordResetLimiter,
  validateBody(confirmPasswordResetGroup1BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { token, newPassword } = req.body;
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const userRes = await pool.query(
        `SELECT id FROM users
         WHERE password_reset_token = $1 AND password_reset_expires_at > NOW()
         LIMIT 1`,
        [tokenHash]
      );

      if (userRes.rows.length === 0) {
        throw new AppError(400, 'Invalid or expired password reset token');
      }

      const userId = userRes.rows[0].id;
      const passwordHash = await bcrypt.hash(newPassword, 12);

      // Update password and invalidate all active sessions
      await pool.query(
        `UPDATE users
         SET password_hash = $1,
             password_reset_token = NULL,
             password_reset_expires_at = NULL,
             session_version = COALESCE(session_version, 0) + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [passwordHash, userId]
      );

      res.status(200).json({
        success: true,
        message: 'Password has been reset successfully. Please log in with your new password.',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/auth/sessions:
 *   get:
 *     summary: List all active sessions for the authenticated user
 *     tags: [Auth Group 1]
 *     security:
 *       - BearerAuth: []
 */
router.get(
  '/sessions',
  requireAuth,
  validateQuery(listSessionsGroup1QuerySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { page, limit } = req.query as unknown as { page: number; limit: number };
      const offset = (page - 1) * limit;

      const sessionsRes = await pool.query(
        `SELECT id, ip_address, user_agent, last_active_at, created_at
         FROM user_sessions
         WHERE user_id = $1
         ORDER BY last_active_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      res.status(200).json({
        success: true,
        data: sessionsRes.rows,
        pagination: {
          page,
          limit,
          total: sessionsRes.rows.length,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/v2/auth/sessions/{sessionId}:
 *   delete:
 *     summary: Revoke a specific active session
 *     tags: [Auth Group 1]
 *     security:
 *       - BearerAuth: []
 */
router.delete(
  '/sessions/:sessionId',
  requireAuth,
  validateParams(revokeSessionGroup1ParamsSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = (req as unknown as Record<string, unknown>).userId as string;
      const { sessionId } = req.params;

      await pool.query(
        'DELETE FROM user_sessions WHERE id = $1 AND user_id = $2',
        [sessionId, userId]
      );

      res.status(200).json({
        success: true,
        message: 'Session revoked successfully',
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
