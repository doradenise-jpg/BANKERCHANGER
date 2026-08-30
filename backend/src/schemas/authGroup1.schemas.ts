import { z } from 'zod';

/**
 * Stellar Ed25519 Public Key regex validator (56 characters starting with 'G')
 */
const stellarAddressRegex = /^G[A-Z2-7]{55}$/;

/**
 * Strong password rule:
 * - Minimum 8 characters, maximum 128 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one digit
 * - At least one special character
 */
const strongPasswordRegex =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,128}$/;

export const registerUserGroup1BodySchema = z.object({
  email: z
    .string()
    .trim()
    .email('Invalid email address format')
    .max(255, 'Email cannot exceed 255 characters'),
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters long')
    .max(30, 'Username cannot exceed 30 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain alphanumeric characters and underscores'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long')
    .max(128, 'Password cannot exceed 128 characters')
    .regex(
      strongPasswordRegex,
      'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'
    ),
  stellar_wallet_address: z
    .string()
    .trim()
    .regex(stellarAddressRegex, 'Must be a valid 56-character Stellar public key (starts with G)')
    .optional(),
});

export const loginUserGroup1BodySchema = z.object({
  email: z
    .string()
    .trim()
    .email('Invalid email address format'),
  password: z
    .string()
    .min(1, 'Password is required'),
});

export const refreshTokenGroup1BodySchema = z.object({
  refreshToken: z
    .string()
    .trim()
    .min(20, 'Invalid refresh token format'),
});

export const mfaSetupGroup1BodySchema = z.object({
  label: z
    .string()
    .trim()
    .max(50, 'Label cannot exceed 50 characters')
    .optional(),
});

export const mfaVerifyGroup1BodySchema = z.object({
  tempToken: z
    .string()
    .trim()
    .min(10, 'Valid temporary token is required'),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'MFA code must be exactly 6 digits'),
});

export const requestPasswordResetGroup1BodySchema = z.object({
  email: z
    .string()
    .trim()
    .email('Invalid email address format'),
});

export const confirmPasswordResetGroup1BodySchema = z.object({
  token: z
    .string()
    .trim()
    .min(16, 'Password reset token is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters long')
    .max(128, 'Password cannot exceed 128 characters')
    .regex(
      strongPasswordRegex,
      'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'
    ),
});

export const revokeSessionGroup1ParamsSchema = z.object({
  sessionId: z
    .string()
    .trim()
    .min(1, 'Session ID is required'),
});

export const listSessionsGroup1QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
