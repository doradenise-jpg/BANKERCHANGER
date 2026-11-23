'use strict';

/**
 * Adds a unique index on blockchain_events so that raw contract events
 * persisted by the indexer during processLedger() are idempotent.
 *
 * The indexer writes the raw event to blockchain_events before calling
 * processEvent(). Re-processing a ledger (retries, overlapping ranges)
 * must not create duplicate rows, so we key on the natural identity of a
 * Stellar contract event: (ledger, transaction_hash, event_index).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const table = await queryInterface.describeTable('blockchain_events');

    // Only add the unique index if the identifying columns exist.
    const required = ['ledger', 'transaction_hash', 'event_index'];
    const missing = required.filter((col) => !table[col]);
    if (missing.length > 0) {
      return;
    }

    await queryInterface.addIndex(
      'blockchain_events',
      ['ledger', 'transaction_hash', 'event_index'],
      {
        name: 'blockchain_events_ledger_tx_event_unique',
        unique: true,
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex(
      'blockchain_events',
      'blockchain_events_ledger_tx_event_unique'
    );
  },
};
