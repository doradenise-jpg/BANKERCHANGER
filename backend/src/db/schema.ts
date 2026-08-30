import {
  pgTable,
  serial,
  text,
  numeric,
  boolean,
  timestamp,
  integer,
  jsonb,
  date,
  uniqueIndex,
  index,
  primaryKey,
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

export const user_streaks = pgTable(
  'user_streaks',
  {
    id: serial('id').primaryKey(),
    address: text('address').notNull(),
    current_streak: integer('current_streak').notNull().default(0),
    best_streak: integer('best_streak').notNull().default(0),
    total_predictions: integer('total_predictions').notNull().default(0),
    last_prediction_date: date('last_prediction_date'),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    address_idx: uniqueIndex('user_streaks_address_idx').on(table.address),
  }),
);

export const achievements = pgTable(
  'achievements',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull().default('general'), // 'streak' | 'volume' | 'referral' | 'general'
    threshold: integer('threshold').notNull().default(0),
    reward_label: text('reward_label').notNull().default(''),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    code_idx: uniqueIndex('achievements_code_idx').on(table.code),
  }),
);

export const user_achievements = pgTable(
  'user_achievements',
  {
    id: serial('id').primaryKey(),
    address: text('address').notNull(),
    achievement_id: integer('achievement_id')
      .notNull()
      .references(() => achievements.id, { onDelete: 'cascade' }),
    earned_at: timestamp('earned_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    address_idx: index('user_achievements_address_idx').on(table.address),
    address_achievement_unique: uniqueIndex('user_achievements_address_achievement_idx').on(
      table.address,
      table.achievement_id,
    ),
  }),
);

export const referrals = pgTable(
  'referrals',
  {
    id: serial('id').primaryKey(),
    referrer_address: text('referrer_address').notNull(),
    referred_address: text('referred_address').notNull(),
    referral_code: text('referral_code').notNull(),
    status: text('status').notNull().default('active'), // 'active' | 'converted'
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    converted_at: timestamp('converted_at', { withTimezone: true }),
  },
  (table) => ({
    referred_address_idx: uniqueIndex('referrals_referred_address_idx').on(table.referred_address),
    referrer_address_idx: index('referrals_referrer_address_idx').on(table.referrer_address),
  }),
);

export const referral_payouts = pgTable(
  'referral_payouts',
  {
    id: serial('id').primaryKey(),
    referrer_address: text('referrer_address').notNull(),
    referred_address: text('referred_address').notNull(),
    level: integer('level').notNull().default(1),
    amount: numeric('amount').notNull().default('0'),
    source_amount: numeric('source_amount').notNull().default('0'),
    rate_bps: integer('rate_bps').notNull().default(0),
    status: text('status').notNull().default('pending'), // 'pending' | 'paid'
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    referrer_address_idx: index('referral_payouts_referrer_address_idx').on(table.referrer_address),
  }),
);

export const user_notifications = pgTable(
  'user_notifications',
  {
    id: serial('id').primaryKey(),
    address: text('address').notNull(),
    type: text('type').notNull(), // 'streak' | 'achievement' | 'referral' | 'leaderboard'
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload').default('{}'),
    read: boolean('read').default(false),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    address_idx: index('user_notifications_address_idx').on(table.address),
    read_idx: index('user_notifications_read_idx').on(table.read),
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

export const user_streaks = pgTable(
  'user_streaks',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id),
    current_streak: integer('current_streak').default(0),
    longest_streak: integer('longest_streak').default(0),
    total_wins: integer('total_wins').default(0),
    total_losses: integer('total_losses').default(0),
    last_result: text('last_result'), // 'win' | 'loss'
    last_resolved_at: timestamp('last_resolved_at', { withTimezone: true }),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    user_id_idx: uniqueIndex('user_streaks_user_id_idx').on(table.user_id),
  }),
);

export const achievements = pgTable(
  'achievements',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    criteria: jsonb('criteria').default('{}'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    code_idx: uniqueIndex('achievements_code_idx').on(table.code),
  }),
);

export const user_achievements = pgTable(
  'user_achievements',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id),
    achievement_code: text('achievement_code').notNull().references(() => achievements.code),
    awarded_at: timestamp('awarded_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    user_id_idx: index('user_achievements_user_id_idx').on(table.user_id),
    user_achievement_idx: uniqueIndex('user_achievements_user_achievement_idx').on(
      table.user_id,
      table.achievement_code,
    ),
  }),
);

export const referrals = pgTable(
  'referrals',
  {
    id: serial('id').primaryKey(),
    referrer_id: text('referrer_id').notNull().references(() => users.id),
    referred_id: text('referred_id').notNull().references(() => users.id),
    status: text('status').default('pending'), // 'pending' | 'active'
    bonus_rate_bps: integer('bonus_rate_bps').default(500),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    referrer_id_idx: index('referrals_referrer_id_idx').on(table.referrer_id),
    referred_id_idx: uniqueIndex('referrals_referred_id_idx').on(table.referred_id),
  }),
);

export const referral_payouts = pgTable(
  'referral_payouts',
  {
    id: serial('id').primaryKey(),
    referrer_id: text('referrer_id').notNull().references(() => users.id),
    referred_id: text('referred_id').notNull().references(() => users.id),
    tier: integer('tier').notNull().default(1),
    source_amount: numeric('source_amount').notNull(),
    payout_amount: numeric('payout_amount').notNull(),
    status: text('status').default('pending'), // 'pending' | 'paid'
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    paid_at: timestamp('paid_at', { withTimezone: true }),
  },
  (table) => ({
    referrer_id_idx: index('referral_payouts_referrer_id_idx').on(table.referrer_id),
    referred_id_idx: index('referral_payouts_referred_id_idx').on(table.referred_id),
    status_idx: index('referral_payouts_status_idx').on(table.status),
  }),
);

export type UserStreak = typeof user_streaks.$inferSelect;
export type NewUserStreak = typeof user_streaks.$inferInsert;
export type Achievement = typeof achievements.$inferSelect;
export type NewAchievement = typeof achievements.$inferInsert;
export type UserAchievement = typeof user_achievements.$inferSelect;
export type NewUserAchievement = typeof user_achievements.$inferInsert;
export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
export type ReferralPayout = typeof referral_payouts.$inferSelect;
export type NewReferralPayout = typeof referral_payouts.$inferInsert;
export type UserNotification = typeof user_notifications.$inferSelect;
export type NewUserNotification = typeof user_notifications.$inferInsert;
