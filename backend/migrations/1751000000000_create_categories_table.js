/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('categories', {
    id: { type: 'varchar(64)', primaryKey: true },
    name: { type: 'varchar(100)', notNull: true },
    slug: { type: 'varchar(100)', notNull: true, unique: true },
    sport_type: { type: 'varchar(50)', notNull: true },
    icon_url: { type: 'text' },
    description: { type: 'text' },
    created_at: {
      type: 'timestamp with time zone',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('categories', 'slug', { unique: true });
};

exports.down = (pgm) => {
  pgm.dropTable('categories');
};
