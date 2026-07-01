/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('admin_audit_log', {
    id: { type: 'serial', primaryKey: true },
    action: { type: 'text', notNull: true },
    details: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('admin_audit_log', 'action');
  pgm.createIndex('admin_audit_log', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('admin_audit_log');
};
