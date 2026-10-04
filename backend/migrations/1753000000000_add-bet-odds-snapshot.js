/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('bets', {
    odds_snapshot: { type: 'jsonb' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('bets', 'odds_snapshot');
};