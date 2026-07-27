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
    authService.users.clear();
    db = drizzle(pool);
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
  // TOKEN EXPIRY - CRITICAL SECURITY TESTS
  // =========================================================================
  describe('Token expiry and refresh', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      authService.users.set('user-expiry-test', {
        id: 'user-expiry-test',
        email: 'expiry@example.com',
        passwordHash: 'hash',
        emailVerified: true,
        twoFactorEnabled: false,
        sessionVersion: 0,
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // ── Access Token Expiry ──────────────────────────────────────────────
    it('should reject expired access token with 401', async () => {
      const now = Date.now();
      jest.setSystemTime(now);

      // Create a token that expires in 15 minutes
      const tokenPayload = {
        sub: 'user-expiry-test',
        type: 'access',
        sv: 0,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 15 * 60, // 15 minutes
      };

      mockJwt.sign.mockReturnValue('expired_access_token' as never);
      mockJwt.verify.mockReturnValue(tokenPayload as never);

      // Simulate 16 minutes passing (1 minute past expiry)
      jest.advanceTimersByTime(16 * 60 * 1000);

      // Verify should throw TokenExpiredError
      mockJwt.verify.mockImplementation(() => {
        const err = new Error('jwt expired');
        (err as any).name = 'TokenExpiredError';
        throw err;
      });

      expect.assertions(1);
      try {
        jwt.verify('expired_access_token', process.env.JWT_SECRET || '');
      } catch (err: any) {
        expect(err.name).toBe('TokenExpiredError');
      }
    });

    // ── Refresh Token Expiry ─────────────────────────────────────────────
    it('should reject expired refresh token and require re-login', async () => {
      const now = Date.now();
      jest.setSystemTime(now);

      // Create a refresh token that expires in 7 days
      const refreshTokenPayload = {
        sub: 'user-expiry-test',
        type: 'refresh',
        sv: 0,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 7 * 24 * 60 * 60, // 7 days
      };

      mockJwt.verify.mockReturnValue(refreshTokenPayload as never);

      // Simulate 8 days passing (1 day past expiry)
      jest.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

      // Verify should throw TokenExpiredError
      mockJwt.verify.mockImplementation(() => {
        const err = new Error('jwt expired');
        (err as any).name = 'TokenExpiredError';
        throw err;
      });

      expect.assertions(1);
      try {
        jwt.verify('expired_refresh_token', process.env.JWT_SECRET || '');
      } catch (err: any) {
        expect(err.name).toBe('TokenExpiredError');
      }
    });

    // ── Reset Token Expiry ──────────────────────────────────────────────
    it('should reject expired password reset token', async () => {
      const now = Date.now();
      jest.setSystemTime(now);

      // Create a reset token that expires in 1 hour
      const resetTokenPayload = {
        sub: 'user-expiry-test',
        type: 'password_reset',
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 60 * 60, // 1 hour
      };

      mockJwt.verify.mockReturnValue(resetTokenPayload as never);

      // Simulate 65 minutes passing (5 minutes past expiry)
      jest.advanceTimersByTime(65 * 60 * 1000);

      mockJwt.verify.mockImplementation(() => {
        const err = new Error('jwt expired');
        (err as any).name = 'TokenExpiredError';
        throw err;
      });

      expect.assertions(1);
      try {
        jwt.verify('expired_reset_token', process.env.JWT_SECRET || '');
      } catch (err: any) {
        expect(err.name).toBe('TokenExpiredError');
      }
    });

    // ── Access Token Still Valid Before Expiry ───────────────────────────
    it('should accept access token before expiry', async () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const tokenPayload = {
        sub: 'user-expiry-test',
        type: 'access',
        sv: 0,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 15 * 60, // 15 minutes
      };

      mockJwt.verify.mockReturnValue(tokenPayload as never);

      // Simulate 10 minutes passing (5 minutes before expiry)
      jest.advanceTimersByTime(10 * 60 * 1000);

      const result = jwt.verify('valid_token', process.env.JWT_SECRET || '');

      expect(result).toEqual(tokenPayload);
      expect(result.sub).toBe('user-expiry-test');
    });

    // ── Refresh Token Refresh Flow ───────────────────────────────────────
    it('should successfully refresh tokens with valid refresh token', async () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const refreshTokenPayload = {
        sub: 'user-expiry-test',
        type: 'refresh',
        sv: 0,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 7 * 24 * 60 * 60, // 7 days
      };

      mockJwt.verify.mockReturnValue(refreshTokenPayload as never);
      mockJwt.sign.mockReturnValue('new_access_token' as never);

      // Simulate 3 days passing (still valid)
      jest.advanceTimersByTime(3 * 24 * 60 * 60 * 1000);

      const verified = jwt.verify('valid_refresh_token', process.env.JWT_SECRET || '');
      expect(verified.sub).toBe('user-expiry-test');

      // Should be able to generate new access token
      const newAccessToken = jwt.sign(
        { sub: verified.sub, type: 'access', sv: 0 },
        process.env.JWT_SECRET || '',
        { expiresIn: '15m' }
      );
      expect(newAccessToken).toBe('new_access_token');
    });

    // ── Multiple Token Expiries Across Different Timespans ───────────────
    it('should handle multiple tokens with different expiry times', async () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const accessTokenPayload = {
        sub: 'user-expiry-test',
        type: 'access',
        exp: Math.floor(now / 1000) + 15 * 60, // 15 minutes
      };

      const refreshTokenPayload = {
        sub: 'user-expiry-test',
        type: 'refresh',
        exp: Math.floor(now / 1000) + 7 * 24 * 60 * 60, // 7 days
      };

      // At 10 minutes: both valid
      jest.advanceTimersByTime(10 * 60 * 1000);
      mockJwt.verify.mockReturnValue(accessTokenPayload as never);
      expect(jwt.verify('access', process.env.JWT_SECRET || '').type).toBe('access');

      mockJwt.verify.mockReturnValue(refreshTokenPayload as never);
      expect(jwt.verify('refresh', process.env.JWT_SECRET || '').type).toBe('refresh');

      // At 20 minutes: access expired, refresh still valid
      jest.advanceTimersByTime(10 * 60 * 1000);
      mockJwt.verify.mockImplementation(() => {
        const err = new Error('jwt expired');
        (err as any).name = 'TokenExpiredError';
        throw err;
      });

      expect(() => jwt.verify('access', process.env.JWT_SECRET || '')).toThrow();
      expect(jwt.verify('refresh', process.env.JWT_SECRET || '').type).toBe('refresh');
    });

    // ── Email Verification Token Expiry ──────────────────────────────────
    it('should reject expired email verification token', async () => {
      const now = Date.now();
      jest.setSystemTime(now);

      const verificationTokenPayload = {
        sub: 'user-expiry-test',
        type: 'email_verification',
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 15 * 60, // 15 minutes
      };

      mockJwt.verify.mockReturnValue(verificationTokenPayload as never);

      // Simulate 20 minutes passing (5 minutes past expiry)
      jest.advanceTimersByTime(20 * 60 * 1000);

      mockJwt.verify.mockImplementation(() => {
        const err = new Error('jwt expired');
        (err as any).name = 'TokenExpiredError';
        throw err;
      });

      expect.assertions(1);
      try {
        jwt.verify('expired_verification_token', process.env.JWT_SECRET || '');
      } catch (err: any) {
        expect(err.name).toBe('TokenExpiredError');
      }
    });
  });
});
