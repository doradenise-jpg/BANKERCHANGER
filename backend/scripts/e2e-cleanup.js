const PREFIX = process.env.E2E_DATA_PREFIX ?? 'e2e_test_';

if (!/^e2e_test_[a-zA-Z0-9_-]*$/.test(PREFIX)) {
  throw new Error('E2E_DATA_PREFIX must start with e2e_test_ and contain only safe characters');
}

if (!process.env.DATABASE_URL) {
  console.log('Skipping E2E database cleanup: DATABASE_URL is not set');
  process.exit(0);
}

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function cleanup() {
  const client = await pool.connect();
  try {
    const requiredTables = [
      'markets',
      'bets',
      'disputes',
      'notification_jobs',
      'distributions',
      'shares',
      'oracle_reports',
      'referral_payouts',
      'referrals',
      'user_achievements',
      'user_streaks',
      'password_reset_tokens',
      'users',
    ];
    const { rows: missingTables } = await client.query(
      `SELECT table_name
      FROM unnest($1::text[]) AS required(table_name)
       WHERE to_regclass('public.' || table_name) IS NULL`,
      [requiredTables],
    );
    if (missingTables.length > 0) {
      console.log('Skipping E2E database cleanup: application schema is not initialized');
      return;
    }

    await client.query('BEGIN');
    await client.query(
      `WITH test_markets AS (
        SELECT market_id FROM markets WHERE left(market_id, length($1)) = $1
       )
       DELETE FROM bets WHERE market_id IN (SELECT market_id FROM test_markets)`,
      [PREFIX],
    );
    await client.query(
      `WITH test_markets AS (
        SELECT market_id FROM markets WHERE left(market_id, length($1)) = $1
       )
       DELETE FROM disputes WHERE market_id IN (SELECT market_id FROM test_markets)`,
      [PREFIX],
    );
    await client.query(
      `WITH test_markets AS (
        SELECT market_id FROM markets WHERE left(market_id, length($1)) = $1
       )
       DELETE FROM notification_jobs WHERE market_id IN (SELECT market_id FROM test_markets)`,
      [PREFIX],
    );
    await client.query(
      `WITH test_markets AS (
        SELECT market_id FROM markets WHERE left(market_id, length($1)) = $1
       )
       DELETE FROM distributions WHERE market_id IN (SELECT market_id FROM test_markets)`,
      [PREFIX],
    );
    await client.query(
      `WITH test_markets AS (
         SELECT market_id FROM markets WHERE left(market_id, length($1)) = $1
       )
       DELETE FROM shares WHERE market_id IN (SELECT market_id FROM test_markets)`,
      [PREFIX],
    );
    await client.query('DELETE FROM oracle_reports WHERE left(match_id, length($1)) = $1', [PREFIX]);
    await client.query('DELETE FROM markets WHERE left(market_id, length($1)) = $1', [PREFIX]);

    await client.query(
      'DELETE FROM referral_payouts WHERE left(referrer_id, length($1)) = $1 OR left(referred_id, length($1)) = $1',
      [PREFIX],
    );
    await client.query(
      'DELETE FROM referrals WHERE left(referrer_id, length($1)) = $1 OR left(referred_id, length($1)) = $1',
      [PREFIX],
    );
    await client.query('DELETE FROM user_achievements WHERE left(user_id, length($1)) = $1', [PREFIX]);
    await client.query('DELETE FROM user_streaks WHERE left(user_id, length($1)) = $1', [PREFIX]);
    await client.query('DELETE FROM password_reset_tokens WHERE left(user_id, length($1)) = $1', [PREFIX]);
    await client.query(
      'DELETE FROM users WHERE left(id, length($1)) = $1 OR left(email, length($1)) = $1',
      [PREFIX],
    );
    await client.query('COMMIT');
    console.log(`Removed E2E records with prefix ${PREFIX}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

cleanup().catch((error) => {
  console.error('E2E database cleanup failed:', error);
  process.exitCode = 1;
});