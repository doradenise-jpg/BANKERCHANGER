/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // markets table
  pgm.createTable('markets', {
    id: { type: 'serial', primaryKey: true },
    market_id: { type: 'text', notNull: true, unique: true },
    contract_address: { type: 'text', notNull: true },
    match_id: { type: 'text', notNull: true },
    fighter_a: { type: 'text', notNull: true },
    fighter_b: { type: 'text', notNull: true },
    weight_class: { type: 'text', notNull: true, default: '' },
    title_fight: { type: 'boolean', notNull: true, default: false },
    venue: { type: 'text', notNull: true, default: '' },
    scheduled_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    status: { type: 'text', notNull: true, default: 'open' },
    outcome: { type: 'text' },
    pool_a: { type: 'numeric', notNull: true, default: 0 },
    pool_b: { type: 'numeric', notNull: true, default: 0 },
    pool_draw: { type: 'numeric', notNull: true, default: 0 },
    total_pool: { type: 'numeric', notNull: true, default: 0 },
    fee_bps: { type: 'integer', notNull: true, default: 200 },
    resolved_at: { type: 'timestamptz' },
    oracle_used: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    ledger_sequence: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.createIndex('markets', 'status', { ifNotExists: true });

  // bets table
  pgm.createTable('bets', {
    id: { type: 'serial', primaryKey: true },
    market_id: { type: 'text', notNull: true, references: 'markets(market_id)' },
    bettor_address: { type: 'text', notNull: true },
    side: { type: 'text', notNull: true },
    amount: { type: 'numeric', notNull: true },
    amount_xlm: { type: 'numeric', notNull: true, default: 0 },
    placed_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    claimed: { type: 'boolean', notNull: true, default: false },
    claimed_at: { type: 'timestamptz' },
    payout: { type: 'numeric' },
    tx_hash: { type: 'text', notNull: true, unique: true },
    ledger_sequence: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.createIndex('bets', 'bettor_address', { ifNotExists: true });
  pgm.createIndex('bets', 'market_id', { ifNotExists: true });
  pgm.createIndex('bets', 'tx_hash', { unique: true, ifNotExists: true });

  // oracle_reports table
  pgm.createTable('oracle_reports', {
    id: { type: 'serial', primaryKey: true },
    market_id: { type: 'text', references: 'markets(market_id)' },
    match_id: { type: 'text', notNull: true },
    oracle_address: { type: 'text', notNull: true },
    outcome: { type: 'text', notNull: true },
    reported_at: { type: 'timestamptz', notNull: true },
    signature: { type: 'text', notNull: true },
    accepted: { type: 'boolean', notNull: true, default: false },
    tx_hash: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('oracle_reports', 'market_id', { ifNotExists: true });

  // blockchain_events table
  pgm.createTable('blockchain_events', {
    id: { type: 'serial', primaryKey: true },
    contract_address: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true, default: '{}' },
    ledger_sequence: { type: 'integer', notNull: true },
    ledger_close_time: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    tx_hash: { type: 'text', notNull: true, unique: true },
    processed: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('blockchain_events', 'processed', { ifNotExists: true });

  // indexer_checkpoints table
  pgm.createTable('indexer_checkpoints', {
    id: { type: 'serial', primaryKey: true },
    last_processed_ledger: { type: 'integer', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('indexer_checkpoints', { ifExists: true });
  pgm.dropTable('blockchain_events', { ifExists: true });
  pgm.dropTable('oracle_reports', { ifExists: true });
  pgm.dropTable('bets', { ifExists: true });
  pgm.dropTable('markets', { ifExists: true });
};
