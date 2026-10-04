const originalEnv = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = {
    ...originalEnv,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    ORACLE_PRIVATE_KEY: `S${'A'.repeat(55)}`,
    ADMIN_JWT_SECRET: 'test-admin-secret',
    FACTORY_CONTRACT_ADDRESS: `C${'A'.repeat(55)}`,
    NODE_ENV: 'production',
    JWT_SECRET: 'x'.repeat(32),
  };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('validateEnv JWT secret', () => {
  it('throws ConfigurationError when JWT_SECRET is missing in production', async () => {
    delete process.env.JWT_SECRET;
    const { ConfigurationError, validateEnv } = await import('../../src/config/env');

    expect(() => validateEnv()).toThrow(ConfigurationError);
    expect(() => validateEnv()).toThrow('JWT_SECRET must be set in production');
  });

  it('rejects secrets shorter than 32 UTF-8 bytes', async () => {
    process.env.JWT_SECRET = 'é'.repeat(15);
    const { ConfigurationError, validateEnv } = await import('../../src/config/env');

    expect(() => validateEnv()).toThrow(ConfigurationError);
    expect(() => validateEnv()).toThrow('JWT_SECRET must be at least 32 bytes');
  });

  it('accepts a secret of at least 32 bytes', async () => {
    const { validateEnv } = await import('../../src/config/env');

    expect(validateEnv().JWT_SECRET).toBe('x'.repeat(32));
  });
});