import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { randomUUID, createHash } from 'crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';
import * as schema from '../db/schema';
import { encrypt, decrypt } from './crypto.service';
import { generateSecret, generateQRCode, verifyToken } from './totp.service';
import { sendPasswordResetEmail, sendEmail } from './email.service';
import { redis } from './cache.service';
import { pool } from '../config/db';
import { getEnv } from '../config/env';
import { password_reset_tokens, users } from '../db/schema';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

const env = getEnv();
const JWT_SECRET = env.JWT_SECRET;
// Per-token-type secrets — each falls back to JWT_SECRET so deployments that
// haven't set the new env vars keep working, but configuring them distinctly
// means a leaked access token secret can't be used to forge refresh, temp-2FA,
// or password-reset tokens (and vice versa).
const JWT_ACCESS_SECRET = env.JWT_ACCESS_SECRET || JWT_SECRET;
const JWT_REFRESH_SECRET = env.JWT_REFRESH_SECRET || JWT_SECRET;
const JWT_TEMP_SECRET = env.JWT_TEMP_SECRET || JWT_SECRET;
const JWT_RESET_SECRET = env.JWT_RESET_SECRET || JWT_SECRET;
const JWT_EXPIRES_IN = env.JWT_EXPIRES_IN || '15m';
const REFRESH_EXPIRES_IN = env.REFRESH_EXPIRES_IN || '7d';
const VERIFY_EMAIL_URL = env.VERIFY_EMAIL_URL || 'http://localhost:3001/auth/verify-email';
const TEMP_TOKEN_EXPIRES_IN = '5m';
const RESET_TOKEN_EXPIRES_IN = '15m';
const BCRYPT_ROUNDS = 12;

const db = drizzle(pool, { schema });

async function generateEmailVerificationToken(userId: string): Promise<string> {
  const token = randomUUID();
  await redis.set(`email_verification:${token}`, userId, 'EX', 15 * 60);
  return token;
}

async function sendVerificationEmail(email: string, token: string, url: string): Promise<boolean> {
  // In test mode, stub the email (don't actually send)
  if (process.env.NODE_ENV === 'test') {
    logger.info({ email, url: `${url}?token=${token}` }, 'Email verification link generated (test mode)');
    return true;
  }

  // Send real verification email
  try {
    const verifyUrl = `${url}?token=${token}`;
    await sendEmail(email, 'verify_email', { verifyUrl });
    return true;
  } catch (err) {
    logger.error({ msg: 'Failed to send verification email', email, error: err });
    return false;
  }
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------
function signAccess(
  userId: string,
  sessionVersion: number,
  role?: string,
  passwordVersion: number = 0,
): string {
  return jwt.sign(
    {
      sub: userId,
      type: 'access',
      sv: sessionVersion,
      password_version: passwordVersion,
      pv: passwordVersion,
      ...(role && { role }),
    },
    JWT_ACCESS_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions,
  );
}

export function createActivityFeedToken(): string {
  return jwt.sign(
    {
      sub: 'public-market-feed',
      type: 'ws_activity',
      scope: 'market_activity:read',
    },
    JWT_ACCESS_SECRET,
    { expiresIn: '5m' } as jwt.SignOptions,
  );
}

function signRefresh(userId: string, sessionVersion: number): string {
  return jwt.sign(
    {
      sub: userId,
      type: 'refresh',
      sv: sessionVersion,
      password_version: passwordVersion,
      pv: passwordVersion,
    },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_EXPIRES_IN } as jwt.SignOptions,
  );
}

function signTemp(userId: string): string {
  return jwt.sign({ sub: userId, type: 'temp_2fa' }, JWT_TEMP_SECRET, {
    expiresIn: TEMP_TOKEN_EXPIRES_IN,
  } as jwt.SignOptions);
}

function signReset(userId: string): string {
  return jwt.sign({ sub: userId, type: 'password_reset' }, JWT_RESET_SECRET, {
    expiresIn: RESET_TOKEN_EXPIRES_IN,
  } as jwt.SignOptions);
}

/** Returns the signing/verification secret for a given token `type` claim. */
function secretForType(type: string): string {
  switch (type) {
    case 'access': return JWT_ACCESS_SECRET;
    case 'refresh': return JWT_REFRESH_SECRET;
    case 'temp_2fa': return JWT_TEMP_SECRET;
    case 'password_reset': return JWT_RESET_SECRET;
    default: return JWT_SECRET;
  }
}

export function verifyJwt(token: string, expectedType: string): jwt.JwtPayload {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secretForType(expectedType)) as jwt.JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(401, 'Token has expired');
    }
    throw new AppError(401, 'Invalid token');
  }
  if (payload.type !== expectedType) throw new AppError(401, 'Invalid token type');
  return payload;
}

/** SHA-256 hex digest of a string — used to fingerprint reset tokens */
async function sha256(input: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Session invalidation via Redis
// ---------------------------------------------------------------------------

/**
 * Key pattern: `session:blocked:<userId>:<sessionVersion>`
 * We store a tombstone in Redis so that even tokens still within their JWT
 * expiry window are rejected after a password reset.
 *
 * In production you would query this in your auth middleware on every request.
 */
async function blockOldSessions(userId: string, oldVersion: number): Promise<void> {
  // Block every version up to and including the old one.
  // TTL matches the longest-lived token (refresh = 7 days).
  const SEVEN_DAYS = 7 * 24 * 60 * 60;
  for (let v = 0; v <= oldVersion; v++) {
    await redis.set(`session:blocked:${userId}:${v}`, '1', 'EX', SEVEN_DAYS);
  }
}

/**
 * Key pattern: `password_version:blocked:${userId}:${passwordVersion}`
 * Blocks in-flight tokens carrying older password versions immediately upon password change.
 */
export async function blockOldPasswordVersions(userId: string, oldPasswordVersion: number): Promise<void> {
  const SEVEN_DAYS = 7 * 24 * 60 * 60;
  for (let v = 0; v <= oldPasswordVersion; v++) {
    await redis.set(`password_version:blocked:${userId}:${v}`, '1', 'EX', SEVEN_DAYS);
  }
}

/**
 * Checks whether a token's password version is stale compared to user's current version (Issue #685).
 */
export async function isPasswordVersionStale(userId: string, tokenPasswordVersion?: number): Promise<boolean> {
  const pv = tokenPasswordVersion ?? 0;
  const key = `password_version:blocked:${userId}:${pv}`;
  const blocked = await redis.get(key);
  if (blocked !== null) return true;

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user) return true;
    const currentVersion = (user as any).password_version ?? 0;
    return pv < currentVersion;
  } catch {
    return false;
  }
}

/**
 * Returns true when the session version or password version carried in a token has been revoked.
 * Call this in your auth middleware after verifying the JWT signature.
 */
export async function isSessionRevoked(
  userId: string,
  sessionVersion: number,
  passwordVersion?: number,
): Promise<boolean> {
  const key = `session:blocked:${userId}:${sessionVersion}`;
  const val = await redis.get(key);
  if (val !== null) return true;

  if (passwordVersion !== undefined) {
    const stale = await isPasswordVersionStale(userId, passwordVersion);
    if (stale) return true;
  }

  return false;
}

/**
 * Refresh tokens are signed JWTs, not stored server-side by default, so an
 * attacker who obtains one before logout could keep minting access tokens
 * until it naturally expires. We additionally store a hash of each issued
 * refresh token in Redis (TTL = remaining token lifetime) and require the
 * hash to be present before honoring a refresh — logout deletes the hash so
 * the token can no longer be used even though the JWT itself is still valid.
 */
function refreshTokenRedisKey(tokenHash: string): string {
  return `refresh_token:${tokenHash}`;
}

async function storeRefreshToken(token: string): Promise<void> {
  const decoded = jwt.decode(token) as jwt.JwtPayload | null;
  const exp = decoded?.exp;
  if (!exp) return;

  const ttl = exp - Math.floor(Date.now() / 1000);
  if (ttl <= 0) return;

  const tokenHash = await sha256(token);
  await redis.set(refreshTokenRedisKey(tokenHash), decoded!.sub as string, 'EX', ttl);
}

async function isRefreshTokenActive(token: string): Promise<boolean> {
  const tokenHash = await sha256(token);
  const val = await redis.get(refreshTokenRedisKey(tokenHash));
  return val !== null;
}

async function revokeRefreshToken(token: string): Promise<void> {
  const tokenHash = await sha256(token);
  await redis.del(refreshTokenRedisKey(tokenHash));
}

export async function isEmailVerified(userId: string): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  return !!user?.email_verified;
}

// ---------------------------------------------------------------------------
// Auth service
// ---------------------------------------------------------------------------

/**
 * Registers a new user and sends verification email.
 * User cannot trade or withdraw until email is verified.
 */
export async function register(
  email: string,
  password: string,
): Promise<{ userId: string; message: string }> {
  // Check if user already exists
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (existing) {
    throw new AppError(409, 'Email already registered');
  }

  // Create user
  const userId = randomUUID();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  
  await db.insert(users).values({
    id: userId,
    email,
    password_hash: passwordHash,
    email_verified: false,
    two_factor_enabled: false,
    session_version: 0,
  });

  // Generate verification token (stored in Redis)
  const token = await generateEmailVerificationToken(userId);

  // Send verification email
  const sent = await sendVerificationEmail(email, token, VERIFY_EMAIL_URL);
  if (!sent) {
    // Clean up user if email send fails
    await db.delete(users).where(eq(users.id, userId));
    throw new AppError(500, 'Failed to send verification email');
  }

  logger.info({ message: 'User registered', userId, email });

  return {
    userId,
    message: 'Registration successful. Please check your email to verify your account.',
  };
}

export async function login(
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string } | { requires2FA: true; tempToken: string }> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (!user) throw new AppError(401, 'Invalid credentials');

  const passwordValid = await bcrypt.compare(password, user.password_hash);
  if (!passwordValid) throw new AppError(401, 'Invalid credentials');

  if (user.two_factor_enabled) {
    return { requires2FA: true, tempToken: signTemp(user.id) };
  }

  const pv = (user as any).password_version ?? 0;
  const accessToken = signAccess(user.id, user.session_version, user.role === 'admin' ? 'admin' : undefined, pv);
  const refreshToken = signRefresh(user.id, user.session_version, pv);
  await storeRefreshToken(refreshToken);

  return { accessToken, refreshToken };
}

/**
 * POST /auth/refresh
 *
 * Mints a new access token from a refresh token. Rejects tokens that fail
 * signature/expiry checks, tokens whose session has been revoked (password
 * reset), and tokens that were revoked server-side via logout.
 */
export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string }> {
  const payload = verifyJwt(refreshToken, 'refresh');
  const userId = payload.sub as string;
  const sessionVersion: number = payload.sv ?? 0;
  const passwordVersion: number | undefined = payload.password_version ?? payload.pv;

  const revoked = await isSessionRevoked(userId, sessionVersion, passwordVersion);
  if (revoked) throw new AppError(401, 'Session has been invalidated');

  const active = await isRefreshTokenActive(refreshToken);
  if (!active) throw new AppError(401, 'Refresh token has been revoked');

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user) throw new AppError(401, 'Invalid session');

  const pv = (user as any).password_version ?? 0;
  return {
    accessToken: signAccess(userId, sessionVersion, user.role === 'admin' ? 'admin' : undefined, pv),
  };
}

/**
 * POST /auth/logout
 *
 * Deletes the server-side record for this refresh token so it can no longer
 * be used to mint access tokens, even though the JWT itself hasn't expired.
 */
export async function logout(refreshToken: string): Promise<void> {
  try {
    verifyJwt(refreshToken, 'refresh');
  } catch {
    return;
  }
  await revokeRefreshToken(refreshToken);
}

// ---------------------------------------------------------------------------
// Password reset flow
// ---------------------------------------------------------------------------
//
// Design note (#357): password reset tokens are stored ONLY in the
// `password_reset_tokens` DB table. Redis is intentionally NOT used here.
//
// Rationale: using the DB as the single source of truth means a Redis flush
// or restart cannot make a consumed token reusable. Single-use enforcement
// is achieved by deleting the row in step 4 of resetPassword() before
// touching the user record.
//
// Redis in this file is only used for:
//   • email_verification tokens  (short-lived, loss-tolerant — user can re-request)
//   • session revocation tombstones (blockOldSessions) — intentional fast-path
//     to reject in-flight JWTs after a password change without a DB round-trip.
//
// Do NOT add Redis writes for password reset tokens here.
// ---------------------------------------------------------------------------

/**
 * POST /auth/forgot-password
 *
 * Always returns the same response regardless of whether the email exists
 * to prevent user enumeration attacks.
 */
export async function forgotPassword(email: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  // No user → do nothing but don't reveal that fact to the caller
  if (!user) return;

  const resetToken = signReset(user.id);
  const tokenHash = await sha256(resetToken);

  // Replace any existing tokens for this user, then insert the new one
  await db.delete(password_reset_tokens)
    .where(eq(password_reset_tokens.user_id, user.id));

  await db.insert(password_reset_tokens).values({
    user_id: user.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 15 * 60 * 1000),
  });

  // Fire-and-forget — failures are swallowed inside sendPasswordResetEmail
  await sendPasswordResetEmail(user.email, resetToken);
}

/**
 * POST /auth/reset-password
 *
 * Validates the reset token, hashes the new password, updates the user
 * record, and invalidates all existing sessions.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  // 1. Verify JWT signature and expiry
  let payload: jwt.JwtPayload;
  try {
    payload = verifyJwt(token, 'password_reset');
  } catch {
    throw new AppError(400, 'Invalid or expired reset token');
  }

  const userId = payload.sub as string;
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user) throw new AppError(400, 'Invalid or expired reset token');

  const incomingHash = await sha256(token);

  // 2. Look up the token in the database
  const [tokenRecord] = await db
    .select()
    .from(password_reset_tokens)
    .where(
      and(
        eq(password_reset_tokens.user_id, userId),
        eq(password_reset_tokens.token_hash, incomingHash),
      ),
    )
    .limit(1);

  if (!tokenRecord) {
    throw new AppError(400, 'Invalid or expired reset token');
  }

  // 3. Check DB-level expiry (belt-and-suspenders with JWT expiry)
  if (new Date() > new Date(tokenRecord.expires_at)) {
    await db.delete(password_reset_tokens).where(eq(password_reset_tokens.id, tokenRecord.id));
    throw new AppError(400, 'Reset token has expired');
  }

  // 4. Consume the token immediately (single-use enforcement)
  await db.delete(password_reset_tokens).where(eq(password_reset_tokens.id, tokenRecord.id));

  // 5. Hash the new password
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  // 6. Invalidate all existing sessions by bumping the session version and password version (Issue #685)
  const oldVersion = user.session_version;
  const newVersion = oldVersion + 1;
  const oldPasswordVersion = (user as any).password_version ?? 0;
  const newPasswordVersion = oldPasswordVersion + 1;

  await db.update(users).set({
    password_hash: passwordHash,
    session_version: newVersion,
    password_version: newPasswordVersion,
    updated_at: new Date(),
  }).where(eq(users.id, userId));

  // 7. Write tombstones to Redis so in-flight tokens are rejected immediately
  await blockOldSessions(userId, oldVersion);
  await blockOldPasswordVersions(userId, oldPasswordVersion);
}

/**
 * Changes user password, bumps password_version and session_version, invalidating all sessions (Issue #685).
 */
export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user) throw new AppError(404, 'User not found');

  const passwordValid = await bcrypt.compare(oldPassword, user.password_hash);
  if (!passwordValid) throw new AppError(401, 'Invalid current password');

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const oldSessionVersion = user.session_version ?? 0;
  const newSessionVersion = oldSessionVersion + 1;
  const oldPasswordVersion = (user as any).password_version ?? 0;
  const newPasswordVersion = oldPasswordVersion + 1;

  await db.update(users).set({
    password_hash: passwordHash,
    session_version: newSessionVersion,
    password_version: newPasswordVersion,
    updated_at: new Date(),
  }).where(eq(users.id, userId));

  await blockOldSessions(userId, oldSessionVersion);
  await blockOldPasswordVersions(userId, oldPasswordVersion);

  const accessToken = signAccess(userId, newSessionVersion, user.role === 'admin' ? 'admin' : undefined, newPasswordVersion);
  const refreshToken = signRefresh(userId, newSessionVersion, newPasswordVersion);
  await storeRefreshToken(refreshToken);

  return { accessToken, refreshToken };
}

// ---------------------------------------------------------------------------
// 2FA service
// ---------------------------------------------------------------------------

/** Step 1: generate secret + QR code; does NOT enable 2FA yet */
export async function setup2FA(
  userId: string,
): Promise<{ qrCode: string; secret: string }> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user) throw new AppError(404, 'User not found');
  if (user.two_factor_enabled) throw new AppError(400, '2FA already enabled');

  const { secret, otpauthUrl } = generateSecret(user.email);
  const encryptedSecret = encrypt(secret);
  
  await db.update(users).set({
    two_factor_secret: encryptedSecret,
    updated_at: new Date(),
  }).where(eq(users.id, userId));

  const qrCode = await generateQRCode(otpauthUrl);
  return { qrCode, secret };
}

/** Step 2: confirm OTP to activate 2FA */
export async function enable2FA(userId: string, otp: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user) throw new AppError(404, 'User not found');
  if (user.two_factor_enabled) throw new AppError(400, '2FA already enabled');
  if (!user.two_factor_secret) throw new AppError(400, 'Run /auth/2fa/setup first');

  const secret = decrypt(user.two_factor_secret);
  if (!verifyToken(secret, otp)) throw new AppError(401, 'Invalid or expired OTP');

  await db.update(users).set({
    two_factor_enabled: true,
    updated_at: new Date(),
  }).where(eq(users.id, userId));
}

/** Disable 2FA — requires current OTP */
export async function disable2FA(userId: string, otp: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user) throw new AppError(404, 'User not found');
  if (!user.two_factor_enabled) throw new AppError(400, '2FA is not enabled');

  const secret = decrypt(user.two_factor_secret!);
  if (!verifyToken(secret, otp)) throw new AppError(401, 'Invalid or expired OTP');

  await db.update(users).set({
    two_factor_enabled: false,
    two_factor_secret: null,
    updated_at: new Date(),
  }).where(eq(users.id, userId));
}

/** Second-step login: verify OTP from temp token, issue final JWT pair */
export async function verify2FA(
  tempToken: string,
  otp: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const payload = verifyJwt(tempToken, 'temp_2fa');
  const userId = payload.sub as string;

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user || !user.two_factor_enabled || !user.two_factor_secret) {
    throw new AppError(401, 'Invalid session');
  }

  const secret = decrypt(user.two_factor_secret);
  if (!verifyToken(secret, otp)) throw new AppError(401, 'Invalid or expired OTP');

  const pv = (user as any).password_version ?? 0;
  const accessToken = signAccess(userId, user.session_version, user.role === 'admin' ? 'admin' : undefined, pv);
  const refreshToken = signRefresh(userId, user.session_version, pv);
  await storeRefreshToken(refreshToken);

  return { accessToken, refreshToken };
}


