import {
  pgTable,
  serial,
  text,
  numeric,
  boolean,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const markets = pgTable(
  'markets',
  {
    id: serial('id').primaryKey(),
    market_id: text('market_id').notNull().unique(),
    contract_address: text('contract_address').notNull(),
    match_id: text('match_id').notNull(),
    fighter_a: text('fighter_a').notNull(),
    fighter_b: text('fighter_b').notNull(),
    weight_class: text('weight_class').default(''),
    title_fight: boolean('title_fight').default(false),
    venue: text('venue').default(''),
    scheduled_at: timestamp('scheduled_at', { withTimezone: true }).defaultNow(),
    status: text('status').default('open'),
    outcome: text('outcome'),
    pool_a: numeric('pool_a').default('0'),
    pool_b: numeric('pool_b').default('0'),
    pool_draw: numeric('pool_draw').default('0'),
    total_pool: numeric('total_pool').default('0'),
    fee_bps: integer('fee_bps').default(200),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    oracle_used: text('oracle_used'),
    lock_before_secs: integer('lock_before_secs').default(3600),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    ledger_sequence: integer('ledger_sequence').default(0),
  },
  (table) => ({
    market_id_idx: uniqueIndex('markets_market_id_idx').on(table.market_id),
    status_idx: index('markets_status_idx').on(table.status),
    scheduled_at_idx: index('markets_scheduled_at_idx').on(table.scheduled_at),
  }),
);

export const bets = pgTable(
  'bets',
  {
    id: serial('id').primaryKey(),
    market_id: text('market_id').notNull().references(() => markets.market_id),
    bettor_address: text('bettor_address').notNull(),
    side: text('side').notNull(),
    amount: numeric('amount').notNull(),
    amount_xlm: numeric('amount_xlm').default('0'),
    placed_at: timestamp('placed_at', { withTimezone: true }).defaultNow(),
    claimed: boolean('claimed').default(false),
    claimed_at: timestamp('claimed_at', { withTimezone: true }),
    payout: numeric('payout'),
    tx_hash: text('tx_hash').notNull().unique(),
    ledger_sequence: integer('ledger_sequence').default(0),
  },
  (table) => ({
    market_id_idx: index('bets_market_id_idx').on(table.market_id),
    bettor_address_idx: index('bets_bettor_address_idx').on(table.bettor_address),
    market_id_claimed_idx: index('bets_market_id_claimed_idx').on(table.market_id, table.claimed),
    tx_hash_idx: uniqueIndex('bets_tx_hash_idx').on(table.tx_hash),
  }),
);

export const blockchain_events = pgTable(
  'blockchain_events',
  {
    id: serial('id').primaryKey(),
    contract_address: text('contract_address').notNull(),
    event_type: text('event_type').notNull(),
    payload: jsonb('payload').default('{}'),
    ledger_sequence: integer('ledger_sequence').notNull(),
    ledger_close_time: timestamp('ledger_close_time', { withTimezone: true }).defaultNow(),
    tx_hash: text('tx_hash').notNull().unique(),
    processed: boolean('processed').default(false),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    tx_hash_idx: uniqueIndex('blockchain_events_tx_hash_idx').on(table.tx_hash),
    processed_idx: index('blockchain_events_processed_idx').on(table.processed),
  }),
);

export const indexer_checkpoints = pgTable('indexer_checkpoints', {
  id: serial('id').primaryKey(),
  last_processed_ledger: integer('last_processed_ledger').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const indexer_ledger_ranges = pgTable(
  'indexer_ledger_ranges',
  {
    id: serial('id').primaryKey(),
    start_ledger: integer('start_ledger').notNull(),
    end_ledger: integer('end_ledger').notNull(),
    processed_at: timestamp('processed_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    rangeUnique: uniqueIndex('indexer_ledger_ranges_range_unique').on(
      table.start_ledger,
      table.end_ledger,
    ),
    startIdx: index('indexer_ledger_ranges_start_idx').on(table.start_ledger),
  }),
);

export const oracle_reports = pgTable(
  'oracle_reports',
  {
    id: serial('id').primaryKey(),
    match_id: text('match_id').notNull(),
    oracle_address: text('oracle_address').notNull(),
    outcome: text('outcome').notNull(),
    reported_at: timestamp('reported_at', { withTimezone: true }).notNull(),
    signature: text('signature').notNull(),
    accepted: boolean('accepted').default(false),
    tx_hash: text('tx_hash'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    match_id_idx: index('oracle_reports_match_id_idx').on(table.match_id),
    oracle_address_idx: index('oracle_reports_oracle_address_idx').on(table.oracle_address),
  }),
);

export const notification_jobs = pgTable(
  'notification_jobs',
  {
    id: serial('id').primaryKey(),
    bettor_address: text('bettor_address').notNull(),
    market_id: text('market_id').notNull().references(() => markets.market_id),
    job_type: text('job_type').notNull(),
    status: text('status').default('pending'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    processed_at: timestamp('processed_at', { withTimezone: true }),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    market_id_idx: index('notification_jobs_market_id_idx').on(table.market_id),
    status_idx: index('notification_jobs_status_idx').on(table.status),
  }),
);

export const disputes = pgTable(
  'disputes',
  {
    id: serial('id').primaryKey(),
    market_id: text('market_id').notNull().references(() => markets.market_id),
    user_id: text('user_id'),
    reason: text('reason').notNull(),
    status: text('status').default('open'),
    admin_notes: text('admin_notes'),
    final_outcome: text('final_outcome'),
    raised_at: timestamp('raised_at', { withTimezone: true }).defaultNow(),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => ({
    market_id_idx: index('disputes_market_id_idx').on(table.market_id),
    status_idx: index('disputes_status_idx').on(table.status),
    user_id_idx: index('disputes_user_id_idx').on(table.user_id),
  }),
);

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    password_hash: text('password_hash').notNull(),
    email_verified: boolean('email_verified').default(false),
    two_factor_enabled: boolean('two_factor_enabled').default(false),
    two_factor_secret: text('two_factor_secret'), // AES-GCM encrypted
    role: text('role').default('user'), // 'user' | 'admin'
    session_version: integer('session_version').default(0),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    email_idx: uniqueIndex('users_email_idx').on(table.email),
  }),
);

export const user_sessions = pgTable(
  'user_sessions',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    session_token: text('session_token').notNull().unique(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    user_id_idx: index('user_sessions_user_id_idx').on(table.user_id),
    expires_at_idx: index('user_sessions_expires_at_idx').on(table.expires_at),
  }),
);

export const password_reset_tokens = pgTable(
  'password_reset_tokens',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id').notNull(),
    token_hash: text('token_hash').notNull().unique(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    user_id_idx: index('password_reset_tokens_user_id_idx').on(table.user_id),
    expires_at_idx: index('password_reset_tokens_expires_at_idx').on(table.expires_at),
  }),
);

export const distributions = pgTable(
  'distributions',
  {
    id: serial('id').primaryKey(),
    market_id: text('market_id').notNull().references(() => markets.market_id),
    bettor_address: text('bettor_address').notNull(),
    amount: numeric('amount').notNull(),
    status: text('status').default('pending'),
    tx_hash: text('tx_hash'),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    market_id_idx: index('distributions_market_id_idx').on(table.market_id),
    status_idx: index('distributions_status_idx').on(table.status),
    created_at_idx: index('distributions_created_at_idx').on(table.created_at),
  }),
);

export const shares = pgTable(
  'shares',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id').notNull(),
    market_id: text('market_id').notNull().references(() => markets.market_id),
    outcome_id: integer('outcome_id').notNull(),
    quantity: numeric('quantity').notNull(),
    cost_basis: numeric('cost_basis').notNull(),
    realized_pnl: numeric('realized_pnl').default('0'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    user_id_idx: index('shares_user_id_idx').on(table.user_id),
    market_id_idx: index('shares_market_id_idx').on(table.market_id),
    user_market_outcome_idx: uniqueIndex('shares_user_market_outcome_idx').on(
      table.user_id,
      table.market_id,
      table.outcome_id
    ),
  }),
);

export const proposals = pgTable(
  'proposals',
  {
    id: serial('id').primaryKey(),
    proposal_id: text('proposal_id').notNull().unique(),
    type: text('type').notNull(), // 'fee_rate' | 'add_token' | 'remove_token' | 'max_discount_rate'
    value: text('value').notNull(), // Stored as string; numeric or address depending on type
    description: text('description').notNull(),
    status: text('status').default('active'), // 'active' | 'passed' | 'failed' | 'executed'
    proposer: text('proposer').notNull(),
    votes_for: numeric('votes_for').default('0'),
    votes_against: numeric('votes_against').default('0'),
    votes_abstain: numeric('votes_abstain').default('0'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    executed_at: timestamp('executed_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    proposal_id_idx: uniqueIndex('proposals_proposal_id_idx').on(table.proposal_id),
    status_idx: index('proposals_status_idx').on(table.status),
    created_at_idx: index('proposals_created_at_idx').on(table.created_at),
  }),
);

export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
export type Bet = typeof bets.$inferSelect;
export type NewBet = typeof bets.$inferInsert;
export type BlockchainEvent = typeof blockchain_events.$inferSelect;
export type OracleReport = typeof oracle_reports.$inferSelect;
export type NotificationJob = typeof notification_jobs.$inferSelect;
export type Dispute = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSession = typeof user_sessions.$inferSelect;
export type PasswordResetToken = typeof password_reset_tokens.$inferSelect;
export type Distribution = typeof distributions.$inferSelect;
export type NewDistribution = typeof distributions.$inferInsert;
export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;
