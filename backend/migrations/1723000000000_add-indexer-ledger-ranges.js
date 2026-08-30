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
};

exports.down = (pgm) => {
  pgm.dropTable('indexer_ledger_ranges');
};
