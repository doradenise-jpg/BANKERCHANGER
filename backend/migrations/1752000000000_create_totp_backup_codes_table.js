/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('totp_backup_codes', {
    id: { type: 'varchar(64)', primaryKey: true },
    user_id: { type: 'varchar(64)', notNull: true },
    code_hash: { type: 'varchar(128)', notNull: true },
    used_at: { type: 'timestamp with time zone', default: null },
    created_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('totp_backup_codes', ['user_id', 'code_hash']);
};

exports.down = (pgm) => {
  pgm.dropTable('totp_backup_codes');
};
