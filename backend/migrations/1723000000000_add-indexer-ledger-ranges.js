/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Contiguous ledger ranges that have been fully processed by the indexer.
  // Rows are kept non-overlapping and adjacent ranges are coalesced so that
  // gap detection after RPC downtime only needs to scan a compact set.
  pgm.createTable('indexer_ledger_ranges', {
    id: { type: 'serial', primaryKey: true },
    start_ledger: { type: 'integer', notNull: true },
    end_ledger: { type: 'integer', notNull: true },
    processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.addConstraint('indexer_ledger_ranges', 'indexer_ledger_ranges_range_unique', {
    unique: ['start_ledger', 'end_ledger'],
  });
  pgm.createIndex('indexer_ledger_ranges', 'start_ledger');

  // Single-row checkpoint table used by StellarIndexer.startIndexer() to
  // resume from the last successfully processed ledger after a restart.
  // The CHECK constraint guarantees exactly one row (id = 1) so checkpoint
  // reads/writes are atomic upserts on a known primary key.
  pgm.createTable('indexer_checkpoint', {
    id: { type: 'integer', primaryKey: true, default: 1 },
    last_ledger: { type: 'integer', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.addConstraint('indexer_checkpoint', 'indexer_checkpoint_singleton', {
    check: 'id = 1',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('indexer_checkpoint');
  pgm.dropTable('indexer_ledger_ranges');
};
