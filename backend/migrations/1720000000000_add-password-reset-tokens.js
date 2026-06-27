/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('password_reset_tokens', {
    id: { type: 'serial', primaryKey: true },
    user_id: { type: 'text', notNull: true },
    token_hash: { type: 'text', notNull: true, unique: true },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('password_reset_tokens', 'user_id');
  pgm.createIndex('password_reset_tokens', 'expires_at');
};

exports.down = (pgm) => {
  pgm.dropTable('password_reset_tokens');
};
