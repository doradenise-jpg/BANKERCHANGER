exports.up = (pgm) => {
  pgm.addColumns('blockchain_events', {
    event_index: { type: 'integer', notNull: true, default: 0 },
  }, { ifNotExists: true });
  pgm.createIndex('blockchain_events', ['tx_hash', 'event_index'], {
    name: 'idx_blockchain_events_tx_idx',
    unique: true,
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('blockchain_events', ['tx_hash', 'event_index'], {
    name: 'idx_blockchain_events_tx_idx',
    ifExists: true,
  });
  pgm.dropColumns('blockchain_events', ['event_index'], { ifExists: true });
};
