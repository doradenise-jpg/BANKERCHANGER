/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('admin_audit_log', {
    admin_id: { type: 'text' },
    target_id: { type: 'text' },
    before_state: { type: 'jsonb' },
    after_state: { type: 'jsonb' },
  });

  pgm.createTable('engagement_xp_events', {
    transaction_hash: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    user_id: { type: 'text', notNull: true },
    points: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.addConstraint('engagement_xp_events', 'engagement_xp_events_transaction_event_key', {
    primaryKey: ['transaction_hash', 'event_type'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('engagement_xp_events');
  pgm.dropColumns('admin_audit_log', ['admin_id', 'target_id', 'before_state', 'after_state']);
};