/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('user_streaks', {
    id: { type: 'serial', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: 'users(id)', unique: true },
    current_streak: { type: 'integer', notNull: true, default: 0 },
    longest_streak: { type: 'integer', notNull: true, default: 0 },
    total_wins: { type: 'integer', notNull: true, default: 0 },
    total_losses: { type: 'integer', notNull: true, default: 0 },
    last_result: { type: 'text' },
    last_resolved_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('user_streaks', 'user_id', { unique: true, name: 'user_streaks_user_id_idx' });

  pgm.createTable('achievements', {
    id: { type: 'serial', primaryKey: true },
    code: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true },
    criteria: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('achievements', 'code', { unique: true, name: 'achievements_code_idx' });

  pgm.createTable('user_achievements', {
    id: { type: 'serial', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: 'users(id)' },
    achievement_code: { type: 'text', notNull: true, references: 'achievements(code)' },
    awarded_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('user_achievements', 'user_id');
  pgm.createIndex('user_achievements', ['user_id', 'achievement_code'], {
    unique: true,
    name: 'user_achievements_user_achievement_idx',
  });

  pgm.createTable('referrals', {
    id: { type: 'serial', primaryKey: true },
    referrer_id: { type: 'text', notNull: true, references: 'users(id)' },
    referred_id: { type: 'text', notNull: true, references: 'users(id)', unique: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    bonus_rate_bps: { type: 'integer', notNull: true, default: 500 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('referrals', 'referrer_id');
  pgm.createIndex('referrals', 'referred_id', { unique: true, name: 'referrals_referred_id_idx' });

  pgm.createTable('referral_payouts', {
    id: { type: 'serial', primaryKey: true },
    referrer_id: { type: 'text', notNull: true, references: 'users(id)' },
    referred_id: { type: 'text', notNull: true, references: 'users(id)' },
    tier: { type: 'integer', notNull: true, default: 1 },
    source_amount: { type: 'numeric', notNull: true },
    payout_amount: { type: 'numeric', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    paid_at: { type: 'timestamptz' },
  });
  pgm.createIndex('referral_payouts', 'referrer_id');
  pgm.createIndex('referral_payouts', 'referred_id');
  pgm.createIndex('referral_payouts', 'status');
};

exports.down = (pgm) => {
  pgm.dropTable('referral_payouts');
  pgm.dropTable('referrals');
  pgm.dropTable('user_achievements');
  pgm.dropTable('achievements');
  pgm.dropTable('user_streaks');
};
