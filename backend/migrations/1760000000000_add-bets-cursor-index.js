/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createIndex('bets', ['bettor_address', { name: 'placed_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }], {
    name: 'bets_bettor_placed_id_idx',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('bets', ['bettor_address', { name: 'placed_at', sort: 'DESC' }, { name: 'id', sort: 'DESC' }], {
    name: 'bets_bettor_placed_id_idx',
  });
};