// ============================================================
// BANKERCHANGER — Engagement Service
// User engagement features for module 8:
//   - Prediction streaks & achievement badges
//   - Referral tree tracking & payout calculations
//   - Real-time WebSocket leaderboard rank updates
// ============================================================

import { pool } from '../config/db';
import * as cache from './cache.service';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { getActivityFeed } from '../websocket/realtime';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STREAK_TTL_SEC = 60 * 60 * 24; // 24h
const LEADERBOARD_TTL_SEC = 60; // 1 minute
const REFERRAL_TTL_SEC = 60 * 60; // 1 hour

// Referral commission tiers (in basis points) applied per level of the tree.
const REFERRAL_RATES_BPS = [100, 50, 20]; // level 1 = 1.00%, level 2 = 0.50%, level 3 = 0.20%

// Default achievement catalogue — seeded idempotently.
export const DEFAULT_ACHIEVEMENTS = [
  {
    code: 'first_prediction',
    name: 'First Prediction',
    description: 'Place your first prediction.',
    category: 'general',
    threshold: 1,
    reward_label: 'First Prediction badge',
  },
  {
    code: 'streak_3',
    name: 'On Fire',
    description: 'Maintain a 3-day prediction streak.',
    category: 'streak',
    threshold: 3,
    reward_label: '3-day streak badge',
  },
  {
    code: 'streak_7',
    name: 'Unstoppable',
    description: 'Maintain a 7-day prediction streak.',
    category: 'streak',
    threshold: 7,
    reward_label: '7-day streak badge',
  },
  {
    code: 'streak_30',
    name: 'Iron Will',
    description: 'Maintain a 30-day prediction streak.',
    category: 'streak',
    threshold: 30,
    reward_label: '30-day streak badge',
  },
  {
    code: 'predictions_10',
    name: 'Sharp Shooter',
    description: 'Place 10 predictions.',
    category: 'volume',
    threshold: 10,
    reward_label: '10 predictions badge',
  },
  {
    code: 'predictions_100',
    name: 'Market Veteran',
    description: 'Place 100 predictions.',
    category: 'volume',
    threshold: 100,
    reward_label: '100 predictions badge',
  },
  {
    code: 'referral_1',
    name: 'Networker',
    description: 'Refer your first friend.',
    category: 'referral',
    threshold: 1,
    reward_label: '1 referral badge',
  },
  {
    code: 'referral_5',
    name: 'Influencer',
    description: 'Refer 5 friends.',
    category: 'referral',
    threshold: 5,
    reward_label: '5 referrals badge',
  },
] as const;

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

export interface UserStreak {
  address: string;
  current_streak: number;
  best_streak: number;
  total_predictions: number;
  last_prediction_date: string | null;
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toDateOnly(value: Date | string | null): string | null {
  if (!value) return null;
  const asDate = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(asDate.getTime())) return String(value);
  return toDateKey(asDate);
}

/**
 * Get (or initialise) a user's prediction streak record.
 * Cached under user:{address}:streak.
 */
export async function getOrInitStreak(address: string): Promise<UserStreak> {
  const cacheKey = `user:${address}:streak`;
  const cached = await cache.get<UserStreak>(cacheKey);
  if (cached) return cached;

  const result = await pool.query(
    `INSERT INTO user_streaks (address, current_streak, best_streak, total_predictions, last_prediction_date)
     VALUES ($1, 0, 0, 0, NULL)
     ON CONFLICT (address) DO NOTHING
     RETURNING *`,
    [address],
  );

  let row = result.rows[0];
  if (!row) {
    const existing = await pool.query(
      'SELECT * FROM user_streaks WHERE address = $1',
      [address],
    );
    row = existing.rows[0];
  }

  const streak: UserStreak = {
    address: row.address,
    current_streak: Number(row.current_streak),
    best_streak: Number(row.best_streak),
    total_predictions: Number(row.total_predictions),
    last_prediction_date: toDateOnly(row.last_prediction_date),
  };
  await cache.set(cacheKey, streak, STREAK_TTL_SEC);
  return streak;
}

/**
 * Record a prediction for an address, advancing or resetting the streak based on
 * whether the previous prediction was made on the previous calendar day.
 * Returns the updated streak plus any newly earned achievement codes.
 */
export async function recordPrediction(
  address: string,
): Promise<{ streak: UserStreak; earnedAchievements: string[] }> {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayKey = toDateKey(yesterday);

  const current = await getOrInitStreak(address);

  let newCurrent = 1;
  if (current.last_prediction_date) {
    const lastKey = current.last_prediction_date;
    newCurrent = lastKey === yesterdayKey ? current.current_streak + 1 : 1;
  }

  const newBest = Math.max(current.best_streak, newCurrent);
  const lastKey = toDateKey(new Date());

  const result = await pool.query(
    `UPDATE user_streaks
        SET current_streak = $2,
            best_streak = $3,
            total_predictions = total_predictions + 1,
            last_prediction_date = $4,
            updated_at = NOW()
      WHERE address = $1
      RETURNING *`,
    [address, newCurrent, newBest, lastKey],
  );

  const row = result.rows[0] ?? {
    address,
    current_streak: newCurrent,
    best_streak: newBest,
    total_predictions: current.total_predictions + 1,
    last_prediction_date: lastKey,
  };

  const streak: UserStreak = {
    address: row.address,
    current_streak: Number(row.current_streak),
    best_streak: Number(row.best_streak),
    total_predictions: Number(row.total_predictions),
    last_prediction_date: toDateOnly(row.last_prediction_date) ?? lastKey,
  };
  await cache.set(`user:${address}:streak`, streak, STREAK_TTL_SEC);

  const earnedAchievements = await evaluateAchievements(address, streak);
  return { streak, earnedAchievements };
}

// ---------------------------------------------------------------------------
// Achievements / Badges
// ---------------------------------------------------------------------------

/**
 * Idempotently seed the default achievement catalogue. Returns the seeded count.
 */
export async function seedDefaultAchievements(): Promise<number> {
  let inserted = 0;
  for (const a of DEFAULT_ACHIEVEMENTS) {
    const result = await pool.query(
      `INSERT INTO achievements (code, name, description, category, threshold, reward_label)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO NOTHING
       RETURNING id`,
      [a.code, a.name, a.description, a.category, a.threshold, a.reward_label],
    );
    inserted += result.rows.length;
  }
  await cache.del('engagement:achievements');
  return inserted;
}

export async function listAchievements(): Promise<Record<string, unknown>[]> {
  const cached = await cache.get<Record<string, unknown>[]>('engagement:achievements');
  if (cached) return cached;

  const result = await pool.query(
    `SELECT id, code, name, description, category, threshold, reward_label
       FROM achievements
      ORDER BY id ASC`,
  );
  await cache.set('engagement:achievements', result.rows, 60 * 60);
  return result.rows;
}

export async function getUserAchievements(address: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT a.id, a.code, a.name, a.description, a.category, a.threshold, a.reward_label,
            ua.earned_at
       FROM user_achievements ua
       JOIN achievements a ON a.id = ua.achievement_id
      WHERE ua.address = $1
      ORDER BY ua.earned_at ASC`,
    [address],
  );
  return result.rows;
}

async function awardAchievement(address: string, achievementId: number): Promise<void> {
  await pool.query(
    `INSERT INTO user_achievements (address, achievement_id)
     VALUES ($1, $2)
     ON CONFLICT (address, achievement_id) DO NOTHING`,
    [address, achievementId],
  );
}

/**
 * Evaluate which achievements a user has crossed based on their streak/stats and
 * award any not yet earned. Returns the list of newly earned achievement codes.
 */
export async function evaluateAchievements(
  address: string,
  streak: UserStreak,
): Promise<string[]> {
  const earned: string[] = [];

  const result = await pool.query(
    `SELECT id, code, category, threshold
       FROM achievements
      WHERE category IN ('streak', 'volume', 'general')
      ORDER BY id ASC`,
  );

  for (const a of result.rows as { id: number; code: string; category: string; threshold: number }[]) {
    let reached = false;
    if (a.category === 'streak') {
      reached = streak.current_streak >= a.threshold;
    } else if (a.category === 'volume') {
      reached = streak.total_predictions >= a.threshold;
    } else if (a.category === 'general') {
      reached = streak.total_predictions >= a.threshold;
    }

    if (!reached) continue;

    const before = await pool.query(
      'SELECT 1 FROM user_achievements WHERE address = $1 AND achievement_id = $2',
      [address, a.id],
    );
    if (before.rows.length > 0) continue;

    await awardAchievement(address, a.id);
    await createNotification(address, 'achievement', 'Achievement unlocked', a.code, { code: a.code });
    earned.push(a.code);
  }

  if (earned.length > 0) {
    await cache.del(`user:${address}:achievements`);
  }
  return earned;
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

/**
 * Register a referral. The referred address must not already be linked.
 * Returns the created referral or null if the referred address is already linked.
 */
export async function registerReferral(
  referrerAddress: string,
  referredAddress: string,
  referralCode: string,
): Promise<Record<string, unknown> | null> {
  if (referrerAddress === referredAddress) {
    throw AppError.badRequest('Cannot refer yourself');
  }

  const existing = await pool.query(
    'SELECT 1 FROM referrals WHERE referred_address = $1',
    [referredAddress],
  );
  if (existing.rows.length > 0) {
    return null;
  }

  const result = await pool.query(
    `INSERT INTO referrals (referrer_address, referred_address, referral_code, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (referred_address) DO NOTHING
     RETURNING *`,
    [referrerAddress, referredAddress, referralCode],
  );

  if (result.rows.length > 0) {
    await cache.del(`user:${referrerAddress}:referrals`);
    // The first referral earns the "Networker" badge.
    await evaluateReferralAchievements(referrerAddress);
  }
  return result.rows[0] ?? null;
}

async function evaluateReferralAchievements(address: string): Promise<void> {
  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_address = $1',
    [address],
  );
  const count = Number(countResult.rows[0]?.count ?? 0);

  const badges = await pool.query(
    `SELECT id, code, threshold FROM achievements WHERE category = 'referral' ORDER BY id ASC`,
  );

  for (const a of badges.rows as { id: number; code: string; threshold: number }[]) {
    if (count < a.threshold) continue;
    const before = await pool.query(
      'SELECT 1 FROM user_achievements WHERE address = $1 AND achievement_id = $2',
      [address, a.id],
    );
    if (before.rows.length > 0) continue;
    await awardAchievement(address, a.id);
    await createNotification(address, 'referral', 'Achievement unlocked', a.code, { code: a.code });
  }
  await cache.del(`user:${address}:achievements`);
}

export interface ReferralTreeNode {
  address: string;
  referredBy?: string;
  children: ReferralTreeNode[];
}

/**
 * Build a referral tree rooted at the given address. The tree follows
 * `referrer_address` links in the referrals table.
 */
export async function buildReferralTree(rootAddress: string): Promise<ReferralTreeNode> {
  const cacheKey = `user:${rootAddress}:tree`;
  const cached = await cache.get<ReferralTreeNode>(cacheKey);
  if (cached) return cached;

  const result = await pool.query(
    'SELECT referrer_address, referred_address FROM referrals ORDER BY id ASC',
  );
  const childrenMap = new Map<string, string[]>();
  for (const row of result.rows as { referrer_address: string; referred_address: string }[]) {
    const list = childrenMap.get(row.referrer_address) ?? [];
    list.push(row.referred_address);
    childrenMap.set(row.referrer_address, list);
  }

  const build = (address: string): ReferralTreeNode => ({
    address,
    children: (childrenMap.get(address) ?? []).map(build),
  });

  const tree = build(rootAddress);
  await cache.set(cacheKey, tree, REFERRAL_TTL_SEC);
  return tree;
}

export interface ReferralPayoutResult {
  totalPayout: string;
  breakdown: { level: number; count: number; amount: string }[];
}

/**
 * Calculate expected referral payouts for a given transaction amount, spreading
 * commission across up to 3 levels of the tree.
 */
export async function calculateReferralPayout(
  rootAddress: string,
  amount: string,
): Promise<ReferralPayoutResult> {
  const tree = await buildReferralTree(rootAddress);
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    throw AppError.badRequest('amount must be a positive number');
  }

  const active = [tree];
  const levelCounts: number[] = [];
  while (active.length > 0) {
    const next: ReferralTreeNode[] = [];
    for (const node of active) next.push(...node.children);
    levelCounts.push(next.length);
    active.length = 0;
    active.push(...next);
    if (levelCounts.length >= REFERRAL_RATES_BPS.length) break;
  }

  const breakdown = levelCounts.map((count, idx) => {
    const rate = REFERRAL_RATES_BPS[idx] ?? 0;
    const level = idx + 1;
    const amountForLevel = (numericAmount * rate) / 10_000;
    return { level, count, amount: amountForLevel.toFixed(7) };
  });

  const totalPayout = breakdown
    .reduce((sum, b) => sum + Number(b.amount), 0)
    .toFixed(7);

  return { totalPayout, breakdown };
}

/**
 * Persist a calculated payouts for a referral event across the tree levels.
 */
export async function recordReferralPayouts(
  referrerAddress: string,
  referredAddress: string,
  amount: string,
  payout: ReferralPayoutResult,
): Promise<void> {
  for (const b of payout.breakdown) {
    if (b.count <= 0 || Number(b.amount) <= 0) continue;
    await pool.query(
      `INSERT INTO referral_payouts
         (referrer_address, referred_address, level, amount, source_amount, rate_bps, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [referrerAddress, referredAddress, b.level, b.amount, amount, REFERRAL_RATES_BPS[b.level - 1] ?? 0],
    );
  }
  await cache.del(`user:${referrerAddress}:payouts`);
}

export async function getReferralSummary(address: string): Promise<Record<string, unknown>> {
  const tree = await buildReferralTree(address);
  const direct = await pool.query(
    `SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_address = $1 AND status = 'active'`,
    [address],
  );
  const converted = await pool.query(
    `SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_address = $1 AND status = 'converted'`,
    [address],
  );
  const payouts = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_payouts WHERE referrer_address = $1`,
    [address],
  );

  return {
    address,
    directCount: Number(direct.rows[0]?.count ?? 0),
    convertedCount: Number(converted.rows[0]?.count ?? 0),
    totalPayout: String(payouts.rows[0]?.total ?? '0'),
    treeDepth: maxTreeDepth(tree),
    treeSize: countTreeNodes(tree),
  };
}

function maxTreeDepth(node: ReferralTreeNode): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(maxTreeDepth));
}

function countTreeNodes(node: ReferralTreeNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countTreeNodes(c), 0);
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  rank: number;
  address: string;
  predictions: number;
  score: number;
}

/**
 * Return the global leaderboard of bettors ranked by engagement score
 * (combination of prediction count and current streak). Results are cached
 * and invalidated on new activity.
 */
export async function getLeaderboard(
  limit = 50,
): Promise<{ entries: LeaderboardEntry[]; updatedAt: string }> {
  const cacheKey = `leaderboard:global:${limit}`;
  const cached = await cache.get<{ entries: LeaderboardEntry[]; updatedAt: string }>(cacheKey);
  if (cached) return cached;

  const result = await pool.query(
    `SELECT address,
            total_predictions,
            (total_predictions + current_streak * 2) AS score
       FROM user_streaks
      ORDER BY score DESC, total_predictions DESC, address ASC
      LIMIT $1`,
    [limit],
  );

  const entries: LeaderboardEntry[] = (result.rows as {
    address: string;
    total_predictions: number;
    score: number;
  }[]).map((row, idx) => ({
    rank: idx + 1,
    address: row.address,
    predictions: Number(row.total_predictions),
    score: Number(row.score),
  }));

  const payload = { entries, updatedAt: new Date().toISOString() };
  await cache.set(cacheKey, payload, LEADERBOARD_TTL_SEC);
  return payload;
}

/**
 * Broadcast a leaderboard rank update over the real-time WebSocket feed.
 * Used after a user records a prediction or earns an achievement so clients
 * subscribed to the leaderboard receive immediate rank/score updates.
 */
export async function publishLeaderboardRank(address: string): Promise<void> {
  const { entries } = await getLeaderboard(200);
  const entry = entries.find((e) => e.address === address) ?? {
    rank: null,
    address,
    predictions: 0,
    score: 0,
  };

  let feed: ReturnType<typeof getActivityFeed>;
  try {
    feed = getActivityFeed();
  } catch {
    logger.warn({ address }, 'leaderboard publish skipped: ActivityFeed not initialised');
    return;
  }

  feed.publish({
    type: 'leaderboard_rank',
    marketId: 'leaderboard',
    address,
    rank: entry.rank,
    score: entry.score,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function createNotification(
  address: string,
  type: string,
  title: string,
  body: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO user_notifications (address, type, title, body, payload, read)
     VALUES ($1, $2, $3, $4, $5, FALSE)`,
    [address, type, title, body, JSON.stringify(payload)],
  );
  await cache.del(`user:${address}:notifications`);
}

export async function getUserNotifications(
  address: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const cacheKey = `user:${address}:notifications`;
  const cached = await cache.get<Record<string, unknown>[]>(cacheKey);
  if (cached) return cached;

  const result = await pool.query(
    `SELECT id, type, title, body, payload, read, created_at
       FROM user_notifications
      WHERE address = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [address, limit],
  );
  const rows = result.rows.map((r) => ({ ...r, payload: r.payload ?? {}, read: r.read }));
  await cache.set(cacheKey, rows, 60);
  return rows;
}

export async function markNotificationRead(
  address: string,
  id: number,
): Promise<{ read: boolean }> {
  const result = await pool.query(
    `UPDATE user_notifications SET read = TRUE
      WHERE address = $1 AND id = $2
      RETURNING id`,
    [address, id],
  );
  if (result.rows.length === 0) {
    throw AppError.notFound('Notification not found');
  }
  await cache.del(`user:${address}:notifications`);
  return { read: true };
}
