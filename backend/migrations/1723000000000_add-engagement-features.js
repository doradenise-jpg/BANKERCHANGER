/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('user_streaks', {
    id: { type: 'serial', primaryKey: true },
    address: { type: 'text', notNull: true },
    current_streak: { type: 'integer', notNull: true, default: 0 },
    best_streak: { type: 'integer', notNull: true, default: 0 },
    total_predictions: { type: 'integer', notNull: true, default: 0 },
    last_prediction_date: { type: 'date' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('user_streaks', 'address', { unique: true });

  pgm.createTable('achievements', {
    id: { type: 'serial', primaryKey: true },
    code: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true },
    category: { type: 'text', notNull: true, default: 'general' },
    threshold: { type: 'integer', notNull: true, default: 0 },
    reward_label: { type: 'text', notNull: true, default: '' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('achievements', 'code', { unique: true });

  pgm.createTable('user_achievements', {
    id: { type: 'serial', primaryKey: true },
    address: { type: 'text', notNull: true },
    achievement_id: { type: 'integer', notNull: true, references: 'achievements(id)', onDelete: 'cascade' },
    earned_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('user_achievements', 'address');
  pgm.createIndex('user_achievements', ['address', 'achievement_id'], { unique: true });

  pgm.createTable('referrals', {
    id: { type: 'serial', primaryKey: true },
    referrer_address: { type: 'text', notNull: true },
    referred_address: { type: 'text', notNull: true },
    referral_code: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'active' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    converted_at: { type: 'timestamptz' },
  });
  pgm.createIndex('referrals', 'referred_address', { unique: true });
  pgm.createIndex('referrals', 'referrer_address');

  pgm.createTable('referral_payouts', {
    id: { type: 'serial', primaryKey: true },
    referrer_address: { type: 'text', notNull: true },
    referred_address: { type: 'text', notNull: true },
    level: { type: 'integer', notNull: true, default: 1 },
    amount: { type: 'numeric', notNull: true, default: 0 },
    source_amount: { type: 'numeric', notNull: true, default: 0 },
    rate_bps: { type: 'integer', notNull: true, default: 0 },
    status: { type: 'text', notNull: true, default: 'pending' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('referral_payouts', 'referrer_address');

  pgm.createTable('user_notifications', {
    id: { type: 'serial', primaryKey: true },
    address: { type: 'text', notNull: true },
    type: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true, default: '{}' },
    read: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('user_notifications', 'address');
  pgm.createIndex('user_notifications', 'read');
};

exports.down = (pgm) => {
  pgm.dropTable('user_notifications');
  pgm.dropTable('referral_payouts');
  pgm.dropTable('referrals');
  pgm.dropTable('user_achievements');
  pgm.dropTable('achievements');
  pgm.dropTable('user_streaks');
};
