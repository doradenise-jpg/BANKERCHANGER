/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('registered_oracles', {
    oracle_address: { type: 'text', primaryKey: true },
    public_key: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('registered_oracles', 'active');
};

exports.down = (pgm) => {
  pgm.dropTable('registered_oracles');
};