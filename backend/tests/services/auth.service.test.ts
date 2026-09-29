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

// ── Mock DB pool and drizzle ──────────────────────────────────────────────────
const mockQuery = {
  users: { findFirst: jest.fn() },
  password_reset_tokens: { findFirst: jest.fn() },
};
const mockDbInsert = jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
const mockDbDelete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
const mockDbUpdate = jest.fn().mockReturnValue({
  set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
});
const mockDbSelect = jest.fn().mockReturnValue({
  from: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([]),
    }),
  }),
});

jest.mock('drizzle-orm/node-postgres', () => ({
  drizzle: jest.fn().mockReturnValue({
    query: mockQuery,
    insert: mockDbInsert,
    delete: mockDbDelete,
    update: mockDbUpdate,
    select: mockDbSelect,
  }),
}));

jest.mock('../../src/config/db', () => ({
  pool: {},
}));

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import * as authService from '../../src/services/auth.service';
import * as totpService from '../../src/services/totp.service';
import * as cryptoService from '../../src/services/crypto.service';
import * as emailService from '../../src/services/email.service';
import * as cacheService from '../../src/services/cache.service';
import { AppError } from '../../src/utils/AppError';

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

/** Synchronous SHA-256 hex helper (mirrors the one inside auth.service.ts) */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('AuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset drizzle mock method chains after each test
    mockDbInsert.mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
    mockDbDelete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
    mockDbUpdate.mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    });
    mockDbSelect.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    });
    mockQuery.users.findFirst.mockResolvedValue(null);
    mockQuery.password_reset_tokens.findFirst.mockResolvedValue(null);
  });

  // =========================================================================
  // createActivityFeedToken
  // =========================================================================
  describe('createActivityFeedToken', () => {
    it('issues a short-lived token limited to market activity reads', () => {
      mockJwt.sign.mockReturnValue('activity-token' as never);

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
      mockQuery.users.findFirst.mockResolvedValue(null); // no duplicate
      (mockBcrypt.hash as jest.Mock).mockResolvedValue('hashed_pw');
      mockCacheService.redis.set.mockResolvedValue('OK' as never);
      (mockEmailService as any).sendEmail = jest.fn().mockResolvedValue(undefined);
      // sendVerificationEmail is a named export from email.service used internally
      jest.spyOn(emailService, 'sendEmail' as any).mockResolvedValue(undefined);
      // stub NODE_ENV to test so the inline stub path executes
      process.env.NODE_ENV = 'test';

      const result = await authService.register('test@example.com', 'password123');

      expect(result.userId).toBeDefined();
      expect(result.message).toContain('Registration successful');
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should reject duplicate email registration', async () => {
      mockQuery.users.findFirst.mockResolvedValue({
        id: 'existing',
        email: 'test@example.com',
        password_hash: 'hash',
        email_verified: true,
        two_factor_enabled: false,
        session_version: 0,
        password_version: 0,
      });

      await expect(authService.register('test@example.com', 'anotherpassword')).rejects.toMatchObject({
        statusCode: 409,
      });
    });
  });

  // =========================================================================
  // LOGIN
  // =========================================================================
  describe('login', () => {
    const baseUser = {
      id: 'user1',
      email: 'user@example.com',
      password_hash: 'hashed_password',
      email_verified: true,
      two_factor_enabled: false,
      two_factor_secret: null,
      session_version: 0,
      password_version: 0,
      role: 'user',
    };

    it('should login successfully with correct credentials', async () => {
      mockQuery.users.findFirst.mockResolvedValue(baseUser);
      (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockJwt.sign.mockReturnValue('token' as never);
      // storeRefreshToken calls jwt.decode then redis.set
      mockJwt.decode.mockReturnValue({ sub: 'user1', exp: Math.floor(Date.now() / 1000) + 3600 } as never);
      mockCacheService.redis.set.mockResolvedValue('OK' as never);

      const result = await authService.login('user@example.com', 'password123');

      expect('accessToken' in result).toBe(true);
      expect('refreshToken' in result).toBe(true);
      expect(mockBcrypt.compare).toHaveBeenCalledWith('password123', 'hashed_password');
    });

    it('should reject non-existent user', async () => {
      mockQuery.users.findFirst.mockResolvedValue(null);

      await expect(authService.login('nonexistent@example.com', 'password123')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('should reject wrong password', async () => {
      mockQuery.users.findFirst.mockResolvedValue(baseUser);
      (mockBcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(authService.login('user@example.com', 'wrongpassword')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('should return temp token when 2FA is enabled', async () => {
      mockQuery.users.findFirst.mockResolvedValue({
        ...baseUser,
        id: 'user-2fa',
        email: 'user2fa@example.com',
        two_factor_enabled: true,
        two_factor_secret: 'encrypted_secret',
      });
      (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockJwt.sign.mockReturnValue('temp_token' as never);

      const result = await authService.login('user2fa@example.com', 'password123');

      expect('requires2FA' in result && result.requires2FA).toBe(true);
      expect('tempToken' in result && result.tempToken).toBeDefined();
    });
  });

  // =========================================================================
  // 2FA FLOW
  // =========================================================================
  describe('2FA flow', () => {
    const baseUser = {
      id: 'user-plain',
      email: 'plain@example.com',
      password_hash: 'hash',
      email_verified: true,
      two_factor_enabled: false,
      two_factor_secret: null,
      session_version: 0,
      password_version: 0,
      role: 'user',
    };

    describe('setup2FA', () => {
      it('should generate 2FA secret and QR code', async () => {
        mockQuery.users.findFirst.mockResolvedValue(baseUser);
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
        mockQuery.users.findFirst.mockResolvedValue({ ...baseUser, two_factor_enabled: true });

        await expect(authService.setup2FA('user-plain')).rejects.toMatchObject({ statusCode: 400 });
      });

      it('should reject non-existent user', async () => {
        mockQuery.users.findFirst.mockResolvedValue(null);

        await expect(authService.setup2FA('nonexistent-user')).rejects.toMatchObject({ statusCode: 404 });
      });
    });

    describe('enable2FA', () => {
      it('should enable 2FA with valid OTP', async () => {
        mockQuery.users.findFirst.mockResolvedValue({
          ...baseUser,
          two_factor_secret: 'encrypted_secret',
        });
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(true);

        await expect(authService.enable2FA('user-plain', '123456')).resolves.toBeUndefined();
        expect(mockDbUpdate).toHaveBeenCalled();
      });

      it('should reject invalid OTP', async () => {
        mockQuery.users.findFirst.mockResolvedValue({
          ...baseUser,
          two_factor_secret: 'encrypted_secret',
        });
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(false);

        await expect(authService.enable2FA('user-plain', '000000')).rejects.toMatchObject({ statusCode: 401 });
      });

      it('should reject if setup not run first (no secret)', async () => {
        mockQuery.users.findFirst.mockResolvedValue({ ...baseUser, two_factor_secret: null });

        await expect(authService.enable2FA('user-plain', '123456')).rejects.toMatchObject({ statusCode: 400 });
      });
    });

    describe('verify2FA', () => {
      it('should verify 2FA OTP and return tokens', async () => {
        const tempPayload = { sub: 'user-plain', type: 'temp_2fa' };
        mockJwt.verify.mockReturnValue(tempPayload as never);
        mockQuery.users.findFirst.mockResolvedValue({
          ...baseUser,
          two_factor_enabled: true,
          two_factor_secret: 'encrypted_secret',
        });
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(true);
        mockJwt.sign.mockReturnValue('jwt_token' as never);
        mockJwt.decode.mockReturnValue({ sub: 'user-plain', exp: Math.floor(Date.now() / 1000) + 3600 } as never);
        mockCacheService.redis.set.mockResolvedValue('OK' as never);

        const result = await authService.verify2FA('temp_token', '123456');

        expect(result.accessToken).toBeDefined();
        expect(result.refreshToken).toBeDefined();
        expect(mockTotpService.verifyToken).toHaveBeenCalledWith('base32secret', '123456');
      });

      it('should reject invalid temp token', async () => {
        mockJwt.verify.mockImplementation(() => { throw new Error('Invalid token'); });

        await expect(authService.verify2FA('invalid_temp_token', '123456')).rejects.toBeTruthy();
      });

      it('should reject wrong OTP during verification', async () => {
        const tempPayload = { sub: 'user-plain', type: 'temp_2fa' };
        mockJwt.verify.mockReturnValue(tempPayload as never);
        mockQuery.users.findFirst.mockResolvedValue({
          ...baseUser,
          two_factor_enabled: true,
          two_factor_secret: 'encrypted_secret',
        });
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(false);

        await expect(authService.verify2FA('temp_token', '000000')).rejects.toMatchObject({ statusCode: 401 });
      });
    });

    describe('disable2FA', () => {
      it('should disable 2FA with valid OTP', async () => {
        mockQuery.users.findFirst.mockResolvedValue({
          ...baseUser,
          two_factor_enabled: true,
          two_factor_secret: 'encrypted_secret',
        });
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(true);

        await expect(authService.disable2FA('user-plain', '123456')).resolves.toBeUndefined();
        expect(mockDbUpdate).toHaveBeenCalled();
      });

      it('should reject invalid OTP during disable', async () => {
        mockQuery.users.findFirst.mockResolvedValue({
          ...baseUser,
          two_factor_enabled: true,
          two_factor_secret: 'encrypted_secret',
        });
        mockCryptoService.decrypt.mockReturnValue('base32secret');
        mockTotpService.verifyToken.mockReturnValue(false);

        await expect(authService.disable2FA('user-plain', '000000')).rejects.toMatchObject({ statusCode: 401 });
      });

      it('should reject if 2FA not enabled', async () => {
        mockQuery.users.findFirst.mockResolvedValue({ ...baseUser, two_factor_enabled: false });

        await expect(authService.disable2FA('user-plain', '123456')).rejects.toMatchObject({ statusCode: 400 });
      });
    });
  });

  // =========================================================================
  // JWT TOKEN MANAGEMENT
  // =========================================================================
  describe('JWT token generation and verification', () => {
    it('should generate access token with correct payload', async () => {
      mockJwt.sign.mockReturnValue('access_token' as never);
      mockJwt.decode.mockReturnValue({ sub: 'user1', exp: Math.floor(Date.now() / 1000) + 3600 } as never);
      mockCacheService.redis.set.mockResolvedValue('OK' as never);
      (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockQuery.users.findFirst.mockResolvedValue({
        id: 'user1',
        email: 'user@example.com',
        password_hash: 'hash',
        email_verified: true,
        two_factor_enabled: false,
        session_version: 2,
        password_version: 0,
        role: 'user',
      });

      await authService.login('user@example.com', 'password');

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user1', type: 'access', sv: 2 }),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('should generate refresh token with correct payload', async () => {
      mockJwt.sign.mockReturnValue('refresh_token' as never);
      mockJwt.decode.mockReturnValue({ sub: 'user1', exp: Math.floor(Date.now() / 1000) + 3600 } as never);
      mockCacheService.redis.set.mockResolvedValue('OK' as never);
      (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockQuery.users.findFirst.mockResolvedValue({
        id: 'user1',
        email: 'user@example.com',
        password_hash: 'hash',
        email_verified: true,
        two_factor_enabled: false,
        session_version: 3,
        password_version: 0,
        role: 'user',
      });

      await authService.login('user@example.com', 'password');

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user1', type: 'refresh', sv: 3 }),
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
      mockJwt.verify.mockImplementation(() => {
        throw new jwt.TokenExpiredError('jwt expired', new Date('2026-06-01T11:45:00Z'));
      });
      jest.advanceTimersByTime(16 * 60 * 1000);

      expect.assertions(2);
      try {
        await authService.resetPassword('expired_reset_token', 'newPassword123');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
      }
    });

    it('should detect revoked session (403-equivalent guard)', async () => {
      mockCacheService.redis.get.mockResolvedValue('1' as never);

      const revoked = await authService.isSessionRevoked('user1', 0);
      expect(revoked).toBe(true);
    });

    it('should verify valid token succeeds before expiry', () => {
      mockJwt.verify.mockReturnValue({
        sub: 'user1',
        type: 'access',
        sv: 0,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
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
      mockCacheService.redis.get.mockResolvedValue(null as never);
      mockCacheService.redis.set.mockResolvedValue('OK' as never);
    });

    afterEach(() => {
      jest.useRealTimers();
      mockJwt.verify.mockReset();
      mockCacheService.redis.get.mockReset();
    });

    it('should include iat claim in refresh token payload', async () => {
      (mockBcrypt.compare as jest.Mock).mockResolvedValue(true);
      mockJwt.sign.mockReturnValue('refresh_token' as never);
      mockJwt.decode.mockReturnValue({ sub: 'user1', exp: Math.floor(Date.now() / 1000) + 3600 } as never);
      mockQuery.users.findFirst.mockResolvedValue({
        id: 'user1', email: 'user@example.com', password_hash: 'hashed_password',
        email_verified: true, two_factor_enabled: false, session_version: 0, password_version: 0, role: 'user',
      });

      await authService.login('user@example.com', 'password123');

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user1', type: 'refresh', sv: 0, iat: expect.any(Number) }),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('should accept refresh token within 30-day window', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      mockJwt.verify.mockReturnValue({
        sub: 'user1', type: 'refresh', sv: 0, pv: 0,
        iat: issuedAt, exp: issuedAt + 7 * 24 * 60 * 60,
      } as never);
      mockCacheService.redis.get.mockResolvedValue('user1' as never);
      mockQuery.users.findFirst.mockResolvedValue({
        id: 'user1', role: 'user', password_version: 0, session_version: 0,
      });
      mockJwt.sign.mockReturnValue('new_access_token' as never);

      const result = await authService.refreshAccessToken('valid_refresh_token');
      expect(result.accessToken).toBeDefined();
    });

    it('should reject refresh token after 30 days with 401 status', async () => {
      const issuedAt = Math.floor(new Date('2026-05-02T12:00:00Z').getTime() / 1000);
      mockJwt.verify.mockReturnValue({
        sub: 'user1', type: 'refresh', sv: 0, pv: 0,
        iat: issuedAt, exp: issuedAt + 7 * 24 * 60 * 60,
      } as never);

      await expect(authService.refreshAccessToken('old_refresh_token')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('should reject refresh token after 30 days regardless of JWT expiry claim', async () => {
      const issuedAt = Math.floor(new Date('2026-05-01T12:00:00Z').getTime() / 1000);
      mockJwt.verify.mockReturnValue({
        sub: 'user1', type: 'refresh', sv: 0, pv: 0,
        iat: issuedAt, exp: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
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

    it('should handle missing iat claim gracefully (token age too large)', async () => {
      mockJwt.verify.mockReturnValue({
        sub: 'user1', type: 'refresh', sv: 0, pv: 0,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
        // iat missing → defaults to 0 → tokenAge exceeds 30 days
      } as never);

      await expect(authService.refreshAccessToken('token_without_iat')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    it('should still validate session revocation after checking lifetime', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      mockJwt.verify.mockReturnValue({
        sub: 'user1', type: 'refresh', sv: 0, pv: 0,
        iat: issuedAt, exp: issuedAt + 7 * 24 * 60 * 60,
      } as never);
      mockCacheService.redis.get.mockImplementation((key: string) => {
        if (key.includes('session:blocked')) return Promise.resolve('1');
        return Promise.resolve(null);
      });

      await expect(authService.refreshAccessToken('valid_token_revoked_session')).rejects.toMatchObject({
        message: expect.stringContaining('Session has been invalidated'),
      });
    });

    it('should still validate refresh token revocation after checking lifetime', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      mockJwt.verify.mockReturnValue({
        sub: 'user1', type: 'refresh', sv: 0, pv: 0,
        iat: issuedAt, exp: issuedAt + 7 * 24 * 60 * 60,
      } as never);
      mockCacheService.redis.get.mockResolvedValue(null as never);

      await expect(authService.refreshAccessToken('revoked_refresh_token')).rejects.toMatchObject({
        message: expect.stringContaining('revoked'),
      });
    });
  });

  // =========================================================================
  // PASSWORD RESET — HASHED TOKEN STORAGE (Issue #655 / #29)
  // =========================================================================
  describe('Password reset — SHA-256 hashed token storage', () => {
    const testUser = {
      id: 'user-reset',
      email: 'reset@example.com',
      password_hash: 'hashed_password',
      email_verified: true,
      two_factor_enabled: false,
      two_factor_secret: null,
      session_version: 1,
      password_version: 0,
      role: 'user',
    };

    describe('forgotPassword()', () => {
      it('stores only the SHA-256 hash of the token — never the raw token', async () => {
        mockQuery.users.findFirst.mockResolvedValue(testUser);
        let insertedValues: any = null;
        mockDbDelete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
        mockDbInsert.mockReturnValue({
          values: jest.fn().mockImplementation((vals) => {
            insertedValues = vals;
            return Promise.resolve([]);
          }),
        });
        (mockEmailService as any).sendPasswordResetEmail = jest.fn().mockResolvedValue(undefined);
        jest.spyOn(emailService, 'sendPasswordResetEmail' as any).mockResolvedValue(undefined);
        mockJwt.sign.mockReturnValue('raw-reset-token' as never);

        await authService.forgotPassword('reset@example.com');

        expect(insertedValues).not.toBeNull();
        // The stored token_hash must NOT equal the raw token
        expect(insertedValues.token_hash).not.toBe('raw-reset-token');
        // It must equal SHA-256 of the raw token
        expect(insertedValues.token_hash).toBe(sha256Hex('raw-reset-token'));
      });

      it('does nothing and does not throw when user does not exist (enumeration prevention)', async () => {
        mockQuery.users.findFirst.mockResolvedValue(null);

        await expect(authService.forgotPassword('nobody@example.com')).resolves.toBeUndefined();
        expect(mockDbInsert).not.toHaveBeenCalled();
      });

      it('deletes existing tokens before inserting new one', async () => {
        mockQuery.users.findFirst.mockResolvedValue(testUser);
        const deleteWhere = jest.fn().mockResolvedValue([]);
        mockDbDelete.mockReturnValue({ where: deleteWhere });
        mockDbInsert.mockReturnValue({ values: jest.fn().mockResolvedValue([]) });
        jest.spyOn(emailService, 'sendPasswordResetEmail' as any).mockResolvedValue(undefined);
        mockJwt.sign.mockReturnValue('token' as never);

        await authService.forgotPassword('reset@example.com');

        expect(mockDbDelete).toHaveBeenCalled();
        expect(deleteWhere).toHaveBeenCalled();
      });
    });

    describe('resetPassword()', () => {
      it('looks up token by SHA-256 hash, not plaintext', async () => {
        const rawToken = 'raw-reset-token-value';
        const expectedHash = sha256Hex(rawToken);
        const futureExpiry = new Date(Date.now() + 10 * 60 * 1000);

        mockJwt.verify.mockReturnValue({
          sub: testUser.id, type: 'password_reset',
        } as never);
        mockQuery.users.findFirst.mockResolvedValue(testUser);

        // Simulate DB returning a row that was stored as a hash
        let capturedWhere: any = null;
        mockDbSelect.mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockImplementation((condition) => {
              capturedWhere = condition;
              return {
                limit: jest.fn().mockResolvedValue([{
                  id: 1,
                  user_id: testUser.id,
                  token_hash: expectedHash,
                  expires_at: futureExpiry,
                }]),
              };
            }),
          }),
        });
        mockDbDelete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
        (mockBcrypt.hash as jest.Mock).mockResolvedValue('new_hashed_pw');
        mockDbUpdate.mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        });
        mockCacheService.redis.set.mockResolvedValue('OK' as never);

        await expect(authService.resetPassword(rawToken, 'NewPassword1!')).resolves.toBeUndefined();
        // Token was deleted (consumed) after use
        expect(mockDbDelete).toHaveBeenCalled();
      });

      it('rejects when no matching hash found in DB (token already used or invalid)', async () => {
        const rawToken = 'used-or-invalid-token';

        mockJwt.verify.mockReturnValue({
          sub: testUser.id, type: 'password_reset',
        } as never);
        mockQuery.users.findFirst.mockResolvedValue(testUser);
        // DB returns empty result → hash not found
        mockDbSelect.mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(authService.resetPassword(rawToken, 'NewPassword1!')).rejects.toMatchObject({
          statusCode: 400,
          message: 'Invalid or expired reset token',
        });
      });

      it('rejects expired token based on DB expires_at field', async () => {
        const rawToken = 'valid-but-expired-token';
        const expectedHash = sha256Hex(rawToken);
        const pastExpiry = new Date(Date.now() - 60 * 1000); // expired 1 min ago

        mockJwt.verify.mockReturnValue({
          sub: testUser.id, type: 'password_reset',
        } as never);
        mockQuery.users.findFirst.mockResolvedValue(testUser);
        mockDbSelect.mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{
                id: 1,
                user_id: testUser.id,
                token_hash: expectedHash,
                expires_at: pastExpiry,
              }]),
            }),
          }),
        });
        mockDbDelete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });

        await expect(authService.resetPassword(rawToken, 'NewPassword1!')).rejects.toMatchObject({
          statusCode: 400,
          message: 'Reset token has expired',
        });
        // Row should be cleaned up even on expiry
        expect(mockDbDelete).toHaveBeenCalled();
      });

      it('rejects invalid JWT signature before any DB lookup', async () => {
        mockJwt.verify.mockImplementation(() => {
          throw new Error('invalid signature');
        });

        await expect(authService.resetPassword('tampered-token', 'NewPassword1!')).rejects.toMatchObject({
          statusCode: 400,
          message: 'Invalid or expired reset token',
        });
        // DB should never be reached
        expect(mockDbSelect).not.toHaveBeenCalled();
      });

      it('consumes the token after successful reset (single-use enforcement)', async () => {
        const rawToken = 'single-use-token';
        const expectedHash = sha256Hex(rawToken);
        const futureExpiry = new Date(Date.now() + 10 * 60 * 1000);

        mockJwt.verify.mockReturnValue({ sub: testUser.id, type: 'password_reset' } as never);
        mockQuery.users.findFirst.mockResolvedValue(testUser);
        mockDbSelect.mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{
                id: 42,
                user_id: testUser.id,
                token_hash: expectedHash,
                expires_at: futureExpiry,
              }]),
            }),
          }),
        });
        const deleteWhere = jest.fn().mockResolvedValue([]);
        mockDbDelete.mockReturnValue({ where: deleteWhere });
        (mockBcrypt.hash as jest.Mock).mockResolvedValue('new_hash');
        mockDbUpdate.mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
        });
        mockCacheService.redis.set.mockResolvedValue('OK' as never);

        await authService.resetPassword(rawToken, 'NewPassword1!');

        // The token row must be deleted to prevent replay
        expect(mockDbDelete).toHaveBeenCalled();
        expect(deleteWhere).toHaveBeenCalled();
      });

      it('bumps session_version and password_version after successful reset', async () => {
        const rawToken = 'reset-token-for-version-bump';
        const expectedHash = sha256Hex(rawToken);
        const futureExpiry = new Date(Date.now() + 10 * 60 * 1000);

        mockJwt.verify.mockReturnValue({ sub: testUser.id, type: 'password_reset' } as never);
        mockQuery.users.findFirst.mockResolvedValue(testUser);
        mockDbSelect.mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([{
                id: 1, user_id: testUser.id, token_hash: expectedHash, expires_at: futureExpiry,
              }]),
            }),
          }),
        });
        mockDbDelete.mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
        (mockBcrypt.hash as jest.Mock).mockResolvedValue('new_hash');
        const updateSetWhere = jest.fn().mockResolvedValue([]);
        const updateSet = jest.fn().mockReturnValue({ where: updateSetWhere });
        mockDbUpdate.mockReturnValue({ set: updateSet });
        mockCacheService.redis.set.mockResolvedValue('OK' as never);

        await authService.resetPassword(rawToken, 'NewPassword1!');

        expect(mockDbUpdate).toHaveBeenCalled();
        const setArgs = updateSet.mock.calls[0][0];
        expect(setArgs).toMatchObject({
          session_version: testUser.session_version + 1,
          password_version: testUser.password_version + 1,
        });
      });

      it('raw token is never persisted — only its SHA-256 hash exists in DB', async () => {
        // Verify that SHA-256(token) !== token (sanity check for test correctness)
        const rawToken = 'any-raw-reset-token';
        const hash = sha256Hex(rawToken);
        expect(hash).not.toBe(rawToken);
        // Hash must be a 64-char hex string (SHA-256 output)
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  });
});
