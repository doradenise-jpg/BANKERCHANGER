/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Create refresh_token_issuances table to track token lifetimes
  // This allows enforcement of 30-day maximum absolute lifetime per acceptance criteria
  pgm.createTable('refresh_token_issuances', {
    id: { type: 'serial', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: 'users(id)' },
    token_hash: { type: 'text', notNull: true, unique: true },
    issued_at: { type: 'timestamptz', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  // Indexes for common queries
  pgm.createIndex('refresh_token_issuances', 'user_id');
  pgm.createIndex('refresh_token_issuances', 'token_hash');
  pgm.createIndex('refresh_token_issuances', 'issued_at');
  pgm.createIndex('refresh_token_issuances', ['user_id', 'revoked_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('refresh_token_issuances');
};
