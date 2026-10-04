// ── Mock env config FIRST (Jest hoists jest.mock above imports) ──────────────
jest.mock('../../src/config/env', () => ({
  getEnv: jest.fn().mockReturnValue({
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    ORACLE_PRIVATE_KEY: 'S' + 'A'.repeat(55),
    ADMIN_JWT_SECRET: 'admin-secret',
    FACTORY_CONTRACT_ADDRESS: 'C' + 'A'.repeat(55),
    PORT: 3000,
    NODE_ENV: 'test',
    JWT_SECRET: 'test-jwt-secret',
    JWT_EXPIRES_IN: '15m',
    REFRESH_EXPIRES_IN: '7d',
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    GENESIS_LEDGER: 100000,
    POLL_INTERVAL_MS: 5000,
    LOG_LEVEL: 'info',
    ENABLE_SWAGGER: false,
    DB_POOL_MAX: 10,
    DB_POOL_IDLE_TIMEOUT_MS: 30000,
    DB_POOL_CONNECTION_TIMEOUT_MS: 5000,
    VERIFY_EMAIL_URL: 'http://localhost:3001/auth/verify-email',
  }),
  validateEnv: jest.fn().mockReturnValue({
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    ORACLE_PRIVATE_KEY: 'S' + 'A'.repeat(55),
    ADMIN_JWT_SECRET: 'admin-secret',
    FACTORY_CONTRACT_ADDRESS: 'C' + 'A'.repeat(55),
    PORT: 3000,
    NODE_ENV: 'test',
    JWT_SECRET: 'test-jwt-secret',
    JWT_EXPIRES_IN: '15m',
    REFRESH_EXPIRES_IN: '7d',
    STELLAR_NETWORK: 'testnet',
    ALLOWED_ORIGINS: 'http://localhost:3000',
    GENESIS_LEDGER: 100000,
    POLL_INTERVAL_MS: 5000,
    LOG_LEVEL: 'info',
    ENABLE_SWAGGER: false,
    DB_POOL_MAX: 10,
    DB_POOL_IDLE_TIMEOUT_MS: 30000,
    DB_POOL_CONNECTION_TIMEOUT_MS: 5000,
    VERIFY_EMAIL_URL: 'http://localhost:3001/auth/verify-email',
  }),
}));

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import * as authService from '../../src/services/auth.service';
import * as totpService from '../../src/services/totp.service';
import * as cryptoService from '../../src/services/crypto.service';
import * as emailService from '../../src/services/email.service';
import * as cacheService from '../../src/services/cache.service';
import { AppError } from '../../src/utils/AppError';
import { pool } from '../../src/config/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { password_reset_tokens } from '../../src/db/schema';
import { eq } from 'drizzle-orm';

jest.mock('../../src/services/totp.service');
jest.mock('../../src/services/crypto.service');
jest.mock('../../src/services/email.service');
jest.mock('../../src/services/cache.service');
jest.mock('bcrypt');
jest.mock('jsonwebtoken');

const mockTotpService = totpService as jest.Mocked<typeof totpService>;
const mockCryptoService = cryptoService as jest.Mocked<typeof cryptoService>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;
const mockCacheService = cacheService as jest.Mocked<typeof cacheService>;
const mockBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;

describe('AuthService', () => {
  let db: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear in-memory users map if it exists (legacy test compatibility)
    if ((authService as any).users?.clear) {
      (authService as any).users.clear();
    }
    db = drizzle(pool);
  });

  describe('createActivityFeedToken', () => {
    it('issues a short-lived token limited to market activity reads', () => {
      mockJwt.sign.mockReturnValue('activity-token');

      expect(authService.createActivityFeedToken()).toBe('activity-token');
      expect(mockJwt.sign).toHaveBeenCalledWith(
        {
          sub: 'public-market-feed',
          type: 'ws_activity',
          scope: 'market_activity:read',
        },
        'test-jwt-secret',
        { expiresIn: '5m' },
      );
    });
  });

  // =========================================================================
  // USER REGISTRATION
  // =========================================================================
  describe('register', () => {
    it('should register a new user successfully', async () => {
      mockCacheService.redis.set.mockResolvedValue(undefined);
      mockEmailService.sendVerificationEmail.mockResolvedValue(true);

      const result = await authService.register('test@example.com', 'password123');

      expect(result.userId).toBeDefined();
      expect(result.message).toContain('Registration successful');
      expect(authService.users.size).toBe(1);

      const user = authService.users.get(result.userId);
      expect(user?.email).toBe('test@example.com');
      expect(user?.emailVerified).toBe(false);
      expect(user?.twoFactorEnabled).toBe(false);
      expect(user?.sessionVersion).toBe(0);
    });

    it('should reject duplicate email registration', async () => {
      mockCacheService.redis.set.mockResolvedValue(undefined);
      mockEmailService.sendVerificationEmail.mockResolvedValue(true);

      await authService.register('test@example.com', 'password123');

      expect.assertions(1);
      try {
        await authService.register('test@example.com', 'anotherpassword');
      } catch (err) {
        expect((err as AppError).statusCode).toBe(409);
      }
    });

    it('should fail if email verification fails', async () => {
      mockCacheService.redis.set.mockResolvedValue(undefined);
      mockEmailService.sendVerificationEmail.mockResolvedValue(false);

      expect.assertions(2);
      try {
        await authService.register('test@example.com', 'password123');
      } catch (err) {
        expect((err as AppError).statusCode).toBe(500);
        expect((err as AppError).message).toContain('Failed to send verification email');
      }
    });

    it('should generate email verification token stored in cache', async () => {
      mockCacheService.redis.set.mockResolvedValue(undefined);
      mockEmailService.sendVerificationEmail.mockResolvedValue(true);

      const result = await authService.register('test@example.com', 'password123');
      const user = authService.users.get(result.userId);

      expect(user?.emailVerificationToken).toBeDefined();
      expect(mockCacheService.redis.set).toHaveBeenCalledWith(
        expect.stringContaining('email_verification:'),
        result.userId,
        'EX',
        15 * 60,
      );
    });
  });

  // =========================================================================
  // LOGIN - BASIC & 2FA
  // =========================================================================
  describe('login', () => {
    beforeEach(() => {
      // Create a test user without 2FA
      authService.users.set('user1', {
        id: 'user1',
        email: 'user@example.com',
        passwordHash: 'hashed_password',
        emailVerified: true,
        twoFactorEnabled: false,
        sessionVersion: 0,
      });
    });

    it('should login successfully with correct credentials', async () => {
      mockBcrypt.compare.mockResolvedValue(true as never);
      mockJwt.sign.mockReturnValue('token' as never);

      const result = await authService.login('user@example.com', 'password123');

      expect('accessToken' in result).toBe(true);
      expect('refreshToken' in result).toBe(true);
      expect(mockBcrypt.compare).toHaveBeenCalledWith('password123', 'hashed_password');
    });

    it('should reject non-existent user', async () => {
      expect.assertions(1);
      try {
        await authService.login('nonexistent@example.com', 'password123');
      } catch (err) {
        expect((err as AppError).statusCode).toBe(401);
      }
    });

    it('should reject wrong password', async () => {
      mockBcrypt.compare.mockResolvedValue(false as never);

      expect.assertions(1);
      try {
        await authService.login('user@example.com', 'wrongpassword');
      } catch (err) {
        expect((err as AppError).statusCode).toBe(401);
      }
    });

    it('should return temp token when 2FA is enabled', async () => {
      authService.users.set('user-2fa', {
        id: 'user-2fa',
        email: 'user2fa@example.com',
        passwordHash: 'hashed_password',
        emailVerified: true,
        twoFactorEnabled: true,
        twoFactorSecret: 'encrypted_secret',
        sessionVersion: 0,
      });

      mockBcrypt.compare.mockResolvedValue(true as never);
      mockJwt.sign.mockReturnValue('temp_token' as never);

      const result = await authService.login('user2fa@example.com', 'password123');

      expect('requires2FA' in result && result.requires2FA).toBe(true);
      expect('tempToken' in result && result.tempToken).toBeDefined();
    });
  });

  // =========================================================================
  // 2FA FLOW - SETUP, ENABLE, VERIFY, DISABLE
  // =========================================================================
  describe('2FA flow', () => {
    beforeEach(() => {
      authService.users.set('user-plain', {
        id: 'user-plain',
        email: 'plain@example.com',
        passwordHash: 'hash',
        emailVerified: true,
        twoFactorEnabled: false,
        sessionVersion: 0,
      });
    });

    describe('setup2FA', () => {
      it('should generate 2FA secret and QR code', async () => {
        mockTotpService.generateSecret.mockReturnValue({
          secret: 'base32secret',
          otpauthUrl: 'otpauth://totp/...',
        });
        mockTotpService.generateQRCode.mockResolvedValue('data:image/png;base64,...');
        mockCryptoService.encrypt.mockReturnValue('encrypted_secret');

        const result = await authService.setup2FA('user-plain');

        expect(result.qrCode).toBeDefined();
        expect(result.secret).toBe('base32secret');
        expect(mockCryptoService.encrypt).toHaveBeenCalledWith('base32secret');
      });

      it('should reject if 2FA already enabled', async () => {
        authService.users.set('user-2fa-enabled', {
          id: 'user-2fa-enabled',
          email: 'enabled@example.com',
          passwordHash: 'hash',
          emailVerified: true,
          twoFactorEnabled: true,
          twoFactorSecret: 'secret',
          sessionVersion: 0,
        });

        expect.assertions(1);
        try {
          await authService.setup2FA('user-2fa-enabled');
        } catch (err) {
          expect((err as AppError).statusCode).toBe(400);
        }
      });

      it('should reject non-existent user', async () => {
        expect.assertions(1);
        try {
          await authService.setup2FA('nonexistent-user');
        } catch (err) {
          expect((err as AppError).statusCode).toBe(404);
        }
      });
    });

    describe('enable2FA', () => {
      beforeEach(async () => {
        mockTotpService.generateSecret.mockReturnValue({
          secret: 'base32secret',
          otpauthUrl: 'otpauth://...',
        });
        mockCryptoService.encrypt.mockReturnValue('encrypted_secret');
        mockTotpService.generateQRCode.mockResolvedValue('qr');

        await authService.setup2FA('user-plain');
      });

      it('should enable 2FA with valid OTP', async () => {
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(true);

        await authService.enable2FA('user-plain', '123456');

        const user = authService.users.get('user-plain');
        expect(user?.twoFactorEnabled).toBe(true);
      });

      it('should reject invalid OTP', async () => {
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(false);

        expect.assertions(1);
        try {
          await authService.enable2FA('user-plain', '000000');
        } catch (err) {
          expect((err as AppError).statusCode).toBe(401);
        }
      });

      it('should reject if setup not run first', async () => {
        authService.users.set('user-no-setup', {
          id: 'user-no-setup',
          email: 'nosetup@example.com',
          passwordHash: 'hash',
          emailVerified: true,
          twoFactorEnabled: false,
          sessionVersion: 0,
        });

        expect.assertions(1);
        try {
          await authService.enable2FA('user-no-setup', '123456');
        } catch (err) {
          expect((err as AppError).statusCode).toBe(400);
        }
      });
    });

    describe('verify2FA', () => {
      beforeEach(async () => {
        mockTotpService.generateSecret.mockReturnValue({
          secret: 'base32secret',
          otpauthUrl: 'otpauth://...',
        });
        mockCryptoService.encrypt.mockReturnValue('encrypted_secret');
        mockTotpService.generateQRCode.mockResolvedValue('qr');
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(true);

        await authService.setup2FA('user-plain');
        await authService.enable2FA('user-plain', '123456');
      });

      it('should verify 2FA OTP and return tokens', async () => {
        const tempPayload = { sub: 'user-plain', type: 'temp_2fa' };
        mockJwt.verify.mockReturnValue(tempPayload as never);
        mockJwt.sign.mockReturnValue('jwt_token' as never);

        const result = await authService.verify2FA('temp_token', '123456');

        expect(result.accessToken).toBeDefined();
        expect(result.refreshToken).toBeDefined();
        expect(mockCryptoService.decrypt).toHaveBeenCalled();
        expect(mockTotpService.verifyToken).toHaveBeenCalledWith('base32secret', '123456');
      });

      it('should reject invalid temp token', async () => {
        mockJwt.verify.mockImplementation(() => {
          throw new Error('Invalid token');
        });

        expect.assertions(1);
        try {
          await authService.verify2FA('invalid_temp_token', '123456');
        } catch {
          expect(true).toBe(true);
        }
      });

      it('should reject wrong OTP during verification', async () => {
        const tempPayload = { sub: 'user-plain', type: 'temp_2fa' };
        mockJwt.verify.mockReturnValue(tempPayload as never);
        mockTotpService.verifyToken.mockReturnValue(false);

        expect.assertions(1);
        try {
          await authService.verify2FA('temp_token', '000000');
        } catch (err) {
          expect((err as AppError).statusCode).toBe(401);
        }
      });
    });

    describe('disable2FA', () => {
      beforeEach(async () => {
        mockTotpService.generateSecret.mockReturnValue({
          secret: 'base32secret',
          otpauthUrl: 'otpauth://...',
        });
        mockCryptoService.encrypt.mockReturnValue('encrypted_secret');
        mockTotpService.generateQRCode.mockResolvedValue('qr');
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(true);

        await authService.setup2FA('user-plain');
        await authService.enable2FA('user-plain', '123456');
      });

      it('should disable 2FA with valid OTP', async () => {
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(true);

        await authService.disable2FA('user-plain', '123456');

        const user = authService.users.get('user-plain');
        expect(user?.twoFactorEnabled).toBe(false);
        expect(user?.twoFactorSecret).toBeUndefined();
      });

      it('should reject invalid OTP during disable', async () => {
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(false);

        expect.assertions(1);
        try {
          await authService.disable2FA('user-plain', '000000');
        } catch (err) {
          expect((err as AppError).statusCode).toBe(401);
        }
      });

      it('should reject if 2FA not enabled', async () => {
        authService.users.set('user-no-2fa', {
          id: 'user-no-2fa',
          email: 'no2fa@example.com',
          passwordHash: 'hash',
          emailVerified: true,
          twoFactorEnabled: false,
          sessionVersion: 0,
        });

        expect.assertions(1);
        try {
          await authService.disable2FA('user-no-2fa', '123456');
        } catch (err) {
          expect((err as AppError).statusCode).toBe(400);
        }
      });
    });
  });

  // =========================================================================
  // JWT TOKEN MANAGEMENT
  // =========================================================================
  describe('JWT token generation and verification', () => {
    it('should generate access token with correct payload', async () => {
      mockJwt.sign.mockReturnValue('access_token' as never);

      authService.users.set('user1', {
        id: 'user1',
        email: 'user@example.com',
        passwordHash: 'hash',
        emailVerified: true,
        twoFactorEnabled: false,
        sessionVersion: 2,
      });

      const result = await authService.login('user@example.com', 'password');
      mockBcrypt.compare.mockResolvedValue(true as never);

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user1',
          type: 'access',
          sv: 2,
        }),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('should generate refresh token with correct payload', async () => {
      mockJwt.sign.mockReturnValue('refresh_token' as never);
      mockBcrypt.compare.mockResolvedValue(true as never);

      authService.users.set('user1', {
        id: 'user1',
        email: 'user@example.com',
        passwordHash: 'hash',
        emailVerified: true,
        twoFactorEnabled: false,
        sessionVersion: 3,
      });

      await authService.login('user@example.com', 'password');

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user1',
          type: 'refresh',
          sv: 3,
        }),
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  // =========================================================================
  // TOKEN EXPIRY
  // =========================================================================
  describe('Token expiry', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
      mockJwt.verify.mockReset();
    });

    it('should reject expired access token with 401 AppError', () => {
      mockJwt.verify.mockImplementation(() => {
        throw new jwt.TokenExpiredError('jwt expired', new Date('2026-06-01T11:59:00Z'));
      });

      expect.assertions(2);
      try {
        authService.verifyJwt('expired_access_token', 'access');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
      }
    });

    it('should reject expired refresh token with 401 AppError', () => {
      mockJwt.verify.mockImplementation(() => {
        throw new jwt.TokenExpiredError('jwt expired', new Date('2026-06-01T11:59:00Z'));
      });

      expect.assertions(2);
      try {
        authService.verifyJwt('expired_refresh_token', 'refresh');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
      }
    });

    it('should reject expired reset token with 400 AppError', async () => {
      // Simulate an expired JWT that verifyJwt will catch
      mockJwt.verify.mockImplementation(() => {
        throw new jwt.TokenExpiredError('jwt expired', new Date('2026-06-01T11:45:00Z'));
      });

      // Advance past the 15-minute reset token expiry window
      jest.advanceTimersByTime(16 * 60 * 1000); // 16 minutes

      // resetPassword calls verifyJwt internally; expired token → 400
      expect.assertions(2);
      try {
        await authService.resetPassword('expired_reset_token', 'newPassword123');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
      }
    });

    it('should reject access token after advancing past default 15m expiry window', () => {
      // Simulate a token that expired at 12:00 — verifyJwt wraps TokenExpiredError as 401
      mockJwt.verify.mockImplementation(() => {
        throw new jwt.TokenExpiredError('jwt expired', new Date('2026-06-01T12:00:00Z'));
      });

      // Advance 16 minutes past the token's issue time
      jest.advanceTimersByTime(16 * 60 * 1000);

      expect.assertions(2);
      try {
        authService.verifyJwt('access_token', 'access');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
      }
    });

    it('should detect revoked session (403-equivalent guard)', async () => {
      // Simulate session blocked in Redis (revoked after password reset)
      mockCacheService.redis.get.mockResolvedValue('1');

      const revoked = await authService.isSessionRevoked('user1', 0);
      expect(revoked).toBe(true);
    });

    it('should verify valid token succeeds before expiry', () => {
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'access',
        sv: 0,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900, // 15 min from now
      } as never);

      const payload = authService.verifyJwt('valid_token', 'access');
      expect(payload.sub).toBe('user1');
      expect(payload.type).toBe('access');
    });
  });

  // =========================================================================
  // REFRESH TOKEN MAXIMUM LIFETIME (30 DAYS)
  // =========================================================================
  describe('Refresh token maximum absolute lifetime (30 days)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      
      authService.users.set('user1', {
        id: 'user1',
        email: 'user@example.com',
        passwordHash: 'hashed_password',
        emailVerified: true,
        twoFactorEnabled: false,
        sessionVersion: 0,
      });

      mockCacheService.redis.get.mockResolvedValue(null);
      mockCacheService.redis.set.mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.useRealTimers();
      mockJwt.verify.mockReset();
      mockCacheService.redis.get.mockReset();
    });

    it('should include iat claim in refresh token payload', async () => {
      mockBcrypt.compare.mockResolvedValue(true as never);
      mockJwt.sign.mockReturnValue('refresh_token' as never);

      await authService.login('user@example.com', 'password123');

      // Verify that signRefresh includes iat claim
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user1',
          type: 'refresh',
          sv: 0,
          iat: expect.any(Number),
        }),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('should accept refresh token within 30-day window', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'refresh',
        sv: 0,
        iat: issuedAt,
        exp: issuedAt + 7 * 24 * 60 * 60, // 7 days from now
      } as never);

      mockCacheService.redis.get.mockResolvedValue('user1');

      const result = await authService.refreshAccessToken('valid_refresh_token');
      expect(result.accessToken).toBeDefined();
      expect(mockJwt.sign).toHaveBeenCalled();
    });

    it('should reject refresh token after 30 days with 401 status', async () => {
      // Issue token at 2026-05-02 (30 days ago from test time 2026-06-01)
      const issuedAt = Math.floor(new Date('2026-05-02T12:00:00Z').getTime() / 1000);
      
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'refresh',
        sv: 0,
        iat: issuedAt,
        exp: issuedAt + 7 * 24 * 60 * 60, // JWT expiry still valid
      } as never);

      expect.assertions(2);
      try {
        await authService.refreshAccessToken('old_refresh_token');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
      }
    });

    it('should reject refresh token after 30 days regardless of JWT expiry claim', async () => {
      // Token issued 31 days ago, but JWT exp claims it's still valid for 60 more days
      const issuedAt = Math.floor(new Date('2026-05-01T12:00:00Z').getTime() / 1000);
      
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'refresh',
        sv: 0,
        iat: issuedAt,
        exp: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60, // Still valid for 60 days
      } as never);

      expect.assertions(3);
      try {
        await authService.refreshAccessToken('token_with_extended_exp');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toContain('30 days');
      }
    });

    it('should accept refresh token at exactly 30 days boundary', async () => {
      // Issue token at exactly 30 days ago
      const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
      const issuedAt = Math.floor(Date.now() / 1000) - THIRTY_DAYS_SECONDS;
      
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'refresh',
        sv: 0,
        iat: issuedAt,
        exp: issuedAt + 7 * 24 * 60 * 60,
      } as never);

      mockCacheService.redis.get.mockResolvedValue('user1');

      // Should still be valid at exactly 30 days (not exceeding)
      const result = await authService.refreshAccessToken('token_at_boundary');
      expect(result.accessToken).toBeDefined();
    });

    it('should reject refresh token just after 30 days (one second)', async () => {
      // Issue token 30 days + 1 second ago
      const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
      const issuedAt = Math.floor(Date.now() / 1000) - THIRTY_DAYS_SECONDS - 1;
      
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'refresh',
        sv: 0,
        iat: issuedAt,
        exp: issuedAt + 7 * 24 * 60 * 60,
      } as never);

      expect.assertions(2);
      try {
        await authService.refreshAccessToken('token_after_boundary');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
      }
    });

    it('should handle missing iat claim gracefully (treat as 0)', async () => {
      // Token without iat claim should fail since token age would be very large
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'refresh',
        sv: 0,
        // iat is missing
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      } as never);

      expect.assertions(2);
      try {
        await authService.refreshAccessToken('token_without_iat');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
      }
    });

    it('should still validate session revocation after checking lifetime', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'refresh',
        sv: 0,
        iat: issuedAt,
        exp: issuedAt + 7 * 24 * 60 * 60,
      } as never);

      // Session is revoked
      mockCacheService.redis.get.mockImplementation((key: string) => {
        if (key.includes('session:blocked')) {
          return Promise.resolve('1');
        }
        return Promise.resolve(null);
      });

      expect.assertions(1);
      try {
        await authService.refreshAccessToken('valid_token_revoked_session');
      } catch (err) {
        expect((err as AppError).message).toContain('Session has been invalidated');
      }
    });

    it('should still validate refresh token revocation after checking lifetime', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'refresh',
        sv: 0,
        iat: issuedAt,
        exp: issuedAt + 7 * 24 * 60 * 60,
      } as never);

      // Token is revoked
      mockCacheService.redis.get.mockResolvedValue(null);

      expect.assertions(1);
      try {
        await authService.refreshAccessToken('revoked_refresh_token');
      } catch (err) {
        expect((err as AppError).message).toContain('revoked');
      }
    });

    it('should advance time and test token expiry transitions correctly', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'refresh',
        sv: 0,
        iat: issuedAt,
        exp: issuedAt + 7 * 24 * 60 * 60,
      } as never);

      mockCacheService.redis.get.mockResolvedValue('user1');

      // Token is valid now
      let result = await authService.refreshAccessToken('token_before_expiry');
      expect(result.accessToken).toBeDefined();

      // Advance 31 days
      jest.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);

      // Now token should be expired
      expect.assertions(3);
      try {
        await authService.refreshAccessToken('token_after_expiry');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
        expect((err as AppError).message).toContain('30 days');
      }
    });
  });
});
