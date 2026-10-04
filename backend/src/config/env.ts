import { z } from 'zod';
import { logger } from '../utils/logger';

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  STELLAR_RPC_URL: z.string().url('STELLAR_RPC_URL must be a valid URL'),
  ORACLE_PRIVATE_KEY: z
    .string()
    .min(1, 'ORACLE_PRIVATE_KEY is required')
    .refine(
      (v) => /^S[A-Z2-7]{55}$/.test(v),
      'ORACLE_PRIVATE_KEY must be a valid Stellar secret key (56-char base32 starting with S)',
    ),
  ADMIN_JWT_SECRET: z.string().min(1, 'ADMIN_JWT_SECRET is required'),
  FACTORY_CONTRACT_ADDRESS: z.string().min(1, 'FACTORY_CONTRACT_ADDRESS is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().refine(
    (secret) => Buffer.byteLength(secret, 'utf8') >= 32,
    'JWT_SECRET must be at least 32 bytes',
  ),
  // Per-token-type secrets (recommended for production). Each falls back to
  // JWT_SECRET when unset, so a single compromised secret only affects the
  // token type it was actually used for once these are configured distinctly.
  JWT_ACCESS_SECRET: z.string().min(1).optional(),
  JWT_REFRESH_SECRET: z.string().min(1).optional(),
  JWT_TEMP_SECRET: z.string().min(1).optional(),
  JWT_RESET_SECRET: z.string().min(1).optional(),
  STELLAR_NETWORK: z.string().default('testnet'),
  HORIZON_URL: z.string().url().optional(),
  ORACLE_PUBLIC_KEY: z.string().optional(),
  ADMIN_PUBLIC_KEY: z.string().optional(),
  TREASURY_CONTRACT_ADDRESS: z.string().optional(),
  ORACLE_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ENABLE_SWAGGER: z.coerce.boolean().default(false),
  GENESIS_LEDGER: z.coerce.number().int().positive().default(100000),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  BOXING_API_URL: z.string().url().optional(),
  SENTRY_DSN: z.string().url().optional(),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  MAX_EXPORT_ROWS: z.coerce.number().int().positive().default(1000000),
});

export type Env = z.infer<typeof envSchema>;

let validatedEnv: Env | null = null;

export function validateEnv(): Env {
  if (validatedEnv) return validatedEnv;

  if (!process.env.JWT_SECRET) {
    const message = process.env.NODE_ENV === 'production'
      ? 'JWT_SECRET must be set in production and must be at least 32 bytes.'
      : 'JWT_SECRET is required and must be at least 32 bytes.';
    throw new ConfigurationError(message);
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map(issue => {
      const path = issue.path.join('.');
      return `${path}: ${issue.message}`;
    });
    logger.error('Environment validation failed:');
    errors.forEach(err => logger.error(`  - ${err}`));
    throw new ConfigurationError(`Environment validation failed: ${errors.join('; ')}`);
  }

  validatedEnv = result.data;
  logger.info('Environment variables validated successfully');
  return validatedEnv;
}

export function getEnv(): Env {
  if (!validatedEnv) {
    throw new Error('Environment not validated. Call validateEnv() first.');
  }
  return validatedEnv;
}
