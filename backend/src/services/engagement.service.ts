// =====================================================
// BANKERCHANGER — Engagement Service
// Gamification & Notifications:
//   * user prediction streaks + achievement badges
//   * referral tree tracking + payout calculations
//   * real-time leaderboard rank updates via WebSocket
// =====================================================

import { pool } from '../config/db';
import { AppError } from '../utils/AppError';
import { getActivityFeed } from '../websocket/realtime';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Achievement catalogue
// ---------------------------------------------------------------------------
const FIRST_WIN = 'first_win';
const STREAK_3 = 'streak_3';
const STREAK_5 = 'streak_5';
const STREAK_10 = 'streak_10';
const WINS_10 = 'wins_10';
const WINS_25 = 'wins_25';
const REFERRAL_1 = 'referral_1';
const REFERRAL_5 = 'referral_5';

const ACHIEVEMENT_CATALOGUE: Array<{ code: string; name: string; description: string; criteria: Record<string, unknown> }> = [
  { code: FIRST_WIN, name: 'First Blood', description: 'Win your first prediction', criteria: { totalWins: 1 } },
  { code: STREAK_3, name: 'On Fire', description: 'Reach a 3-win prediction streak', criteria: { streak: 3 } },
  { code: STREAK_5, name: 'Unstoppable', description: 'Reach a 5-win prediction streak', criteria: { streak: 5 } },
  { code: STREAK_10, name: 'Legendary Streak', description: 'Reach a 10-win prediction streak', criteria: { streak: 10 } },
  { code: WINS_10, name: 'Decade', description: 'Win 10 predictions in total', criteria: { totalWins: 10 } },
  { code: WINS_25, name: 'Sharpshooter', description: 'Win 25 predictions in total', criteria: { totalWins: 25 } },
  { code: REFERRAL_1, name: 'Influencer', description: 'Refer your first friend', criteria: { referrals: 1 } },
  { code: REFERRAL_5, name: 'Networker', description: 'Refer 5 friends', criteria: { referrals: 5 } },
];

// ---------------------------------------------------------------------------
// EngagementService
// ---------------------------------------------------------------------------
export class EngagementService {
  /** Seeded achievement definitions are inserted lazily on first use. */
  private async ensureAchievements(executor: any = pool): Promise<void> {
    for (const a of ACHIEVEMENT_CATALOGUE) {
      await executor.query(
        `INSERT INTO achievements (code, name, description, criteria)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (code) DO NOTHING`,
        [a.code, a.name, a.description, JSON.stringify(a.criteria)],
      );
    }
  }

  /**
   * Records the outcome of a resolved prediction for a bettor and updates
   * their streak. When a new achievement is earned, emits a leaderboard
   * rank update over the WebSocket channel.
   */
  async recordPredictionResult(userId: string, won: boolean): Promise<{ currentStreak: number; newAchievements: string[] }> {
    const newAchievements: string[] = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO user_streaks (user_id, current_streak, longest_streak)
         VALUES ($1, 0, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await this.ensureAchievements(client);

      const { rows } = await client.query(
        `SELECT current_streak, longest_streak, total_wins, total_losses
         FROM user_streaks WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const row = rows[0] ?? { current_streak: 0, longest_streak: 0, total_wins: 0, total_losses: 0 };

      const currentStreak = won ? row.current_streak + 1 : 0;
      const longestStreak = Math.max(row.longest_streak, currentStreak);
      const totalWins = row.total_wins + (won ? 1 : 0);
      const totalLosses = row.total_losses + (won ? 0 : 1);

      await client.query(
        `UPDATE user_streaks
         SET current_streak = $1, longest_streak = $2, total_wins = $3, total_losses = $4,
             last_result = $5, last_resolved_at = NOW(), updated_at = NOW()
         WHERE user_id = $6`,
        [currentStreak, longestStreak, totalWins, totalLosses, won ? 'win' : 'loss', userId],
      );

      newAchievements.push(
        ...(await this.evaluateAchievements(client, userId, { currentStreak, longestStreak, totalWins })),
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, userId }, 'EngagementService.recordPredictionResult failed');
      throw err;
    } finally {
      client.release();
    }

    // Real-time leaderboard rank update
    try {
      const rank = await this.computeRank(userId);
      getActivityFeed().publishLeaderboardUpdate({ userId, rank, currentStreak });
    } catch (err) {
      logger.warn({ err, userId }, 'Leaderboard update publish failed');
    }

    return { currentStreak, newAchievements };
  }

  /** Awards any unearned achievements matching the user's latest stats. */
  private async evaluateAchievements(
    client: any,
    userId: string,
    stats: { currentStreak: number; longestStreak: number; totalWins: number },
  ): Promise<string[]> {
    const earned: string[] = [];

    const { rows: referrals } = await client.query(
      `SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_id = $1`,
      [userId],
    );
    const referralCount = referrals[0]?.count ?? 0;

    for (const a of ACHIEVEMENT_CATALOGUE) {
      if (!this.meetsCriteria(a.code, stats, referralCount)) continue;

      const { rows } = await client.query(
        `INSERT INTO user_achievements (user_id, achievement_code)
         VALUES ($1, $2)
         ON CONFLICT (user_id, achievement_code) DO NOTHING
         RETURNING achievement_code`,
        [userId, a.code],
      );
      if (rows.length > 0) earned.push(a.code);
    }

    return earned;
  }

  private meetsCriteria(
    code: string,
    stats: { currentStreak: number; longestStreak: number; totalWins: number },
    referralCount: number,
  ): boolean {
    switch (code) {
      case FIRST_WIN:
      case WINS_10:
      case WINS_25:
        return stats.totalWins >= this.thresholdFor(code);
      case STREAK_3:
      case STREAK_5:
      case STREAK_10:
        return stats.longestStreak >= this.thresholdFor(code);
      case REFERRAL_1:
      case REFERRAL_5:
        return referralCount >= this.thresholdFor(code);
      default:
        return false;
    }
  }

  private thresholdFor(code: string): number {
    switch (code) {
      case FIRST_WIN: return 1;
      case WINS_10: return 10;
      case WINS_25: return 25;
      case STREAK_3: return 3;
      case STREAK_5: return 5;
      case STREAK_10: return 10;
      case REFERRAL_1: return 1;
      case REFERRAL_5: return 5;
      default: return 0;
    }
  }

  /** Returns the user's streak and badges plus referral summary. */
  async getUserEngagement(userId: string): Promise<{
    streak: { current: number; longest: number; totalWins: number; totalLosses: number };
    achievements: Array<{ code: string; name: string; description: string; awardedAt: string }>;
    referrals: { count: number; totalPayout: string };
  }> {
    await this.ensureAchievements();

    const { rows: streakRows } = await pool.query(
      `SELECT current_streak, longest_streak, total_wins, total_losses
       FROM user_streaks WHERE user_id = $1`,
      [userId],
    );
    const streak = streakRows[0] ?? { current_streak: 0, longest_streak: 0, total_wins: 0, total_losses: 0 };

    const { rows: badgeRows } = await pool.query(
      `SELECT ua.achievement_code AS code, a.name, a.description, ua.awarded_at
       FROM user_achievements ua
       JOIN achievements a ON a.code = ua.achievement_code
       WHERE ua.user_id = $1
       ORDER BY ua.awarded_at ASC`,
      [userId],
    );

    const { rows: referRows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM referrals WHERE referrer_id = $1 AND status = 'active')::int AS count,
         (SELECT COALESCE(SUM(payout_amount::numeric), 0) FROM referral_payouts WHERE referrer_id = $1)::text AS total_payout`,
      [userId],
    );
    const refer = referRows[0] ?? { count: 0, total_payout: '0' };

    return {
      streak: {
        current: streak.current_streak,
        longest: streak.longest_streak,
        totalWins: streak.total_wins,
        totalLosses: streak.total_losses,
      },
      achievements: badgeRows.map((b) => ({
        code: b.code,
        name: b.name,
        description: b.description,
        awardedAt: new Date(b.awarded_at).toISOString(),
      })),
      referrals: { count: refer.count, totalPayout: refer.total_payout },
    };
  }

  /** Records a referral edge. A referred user can only be attributed once. */
  async recordReferral(referrerId: string, referredId: string): Promise<{ id: number; status: string }> {
    if (referrerId === referredId) {
      throw AppError.badRequest('A user cannot refer themselves', 'SELF_REFERRAL');
    }
    const { rows } = await pool.query(
      `INSERT INTO referrals (referrer_id, referred_id, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (referred_id) DO NOTHING
       RETURNING id, status`,
      [referrerId, referredId],
    );
    if (rows.length === 0) {
      throw AppError.conflict('Referred user is already attributed to a referrer', 'REFERRAL_EXISTS');
    }

    // Award referral achievement + broadcast rank update
    await this.ensureAchievements();
    await pool.query(
      `INSERT INTO user_achievements (user_id, achievement_code)
       SELECT $1, code FROM achievements
       WHERE code IN ('referral_1','referral_5')
         AND (SELECT COUNT(*) FROM referrals WHERE referrer_id = $1) >=
             (CASE code WHEN 'referral_5' THEN 5 ELSE 1 END)
         AND NOT EXISTS (
           SELECT 1 FROM user_achievements ua WHERE ua.user_id = $1 AND ua.achievement_code = achievements.code
         )`,
      [referrerId],
    );

    try {
      getActivityFeed().publishLeaderboardUpdate({
        userId: referrerId,
        rank: await this.computeRank(referrerId),
        currentStreak: 0,
      });
    } catch {
      /* leaderboard broadcast is best-effort */
    }

    return { id: rows[0].id, status: rows[0].status };
  }

  /**
   * Computes multi-level referral payouts for a referrer from active referrals
   * using a narrowing rate schedule (e.g. 5% level-1, 2% level-2, 1% level-3).
   */
  async calculateReferralPayouts(referrerId: string): Promise<
    Array<{ referredId: string; tier: number; sourceAmount: string; payoutAmount: string }>
  > {
    const RATE_BPS: Record<number, number> = { 1: 500, 2: 200, 3: 100 };

    // Source amount = total volume (wagered) by each referred user's chain.
    const { rows: referred } = await pool.query(
      `SELECT referred_id FROM referrals WHERE referrer_id = $1 AND status = 'active'`,
      [referrerId],
    );

    const payouts: Array<{ referredId: string; tier: number; sourceAmount: string; payoutAmount: string }> = [];
    for (const r of referred) {
      const { rows: vol } = await pool.query(
        `SELECT COALESCE(SUM(amount::numeric), 0)::text AS volume
         FROM bets WHERE bettor_address = $1`,
        [r.referred_id],
      );
      const source = vol[0]?.volume ?? '0';
      const bps = RATE_BPS[1] ?? 0;
      const payout = (Number(source) * bps) / 10_000;
      payouts.push({ referredId: r.referred_id, tier: 1, sourceAmount: source, payoutAmount: payout.toFixed(7) });
    }

    // Persist pending payout rows for the ledger.
    for (const p of payouts) {
      await pool.query(
        `INSERT INTO referral_payouts (referrer_id, referred_id, tier, source_amount, payout_amount, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         ON CONFLICT DO NOTHING`,
        [referrerId, p.referredId, p.tier, p.sourceAmount, p.payoutAmount],
      );
    }

    return payouts;
  }

  /** Best-effort rank computation for a user (1 = highest streak, then wins). */
  private async computeRank(userId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int + 1 AS rank
       FROM user_streaks
       WHERE (longest_streak > (SELECT longest_streak FROM user_streaks WHERE user_id = $1)
           OR (longest_streak = (SELECT longest_streak FROM user_streaks WHERE user_id = $1)
               AND total_wins > (SELECT total_wins FROM user_streaks WHERE user_id = $1)))`,
      [userId],
    );
    return rows[0]?.rank ?? 1;
  }

  /** Returns the global leaderboard, ranked by longest streak then total wins. */
  async getLeaderboard(limit = 50): Promise<Array<{ userId: string; rank: number; currentStreak: number; longestStreak: number; totalWins: number }>> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const { rows } = await pool.query(
      `SELECT user_id,
              ROW_NUMBER() OVER (ORDER BY longest_streak DESC, total_wins DESC, updated_at ASC) AS rank,
              current_streak, longest_streak, total_wins
       FROM user_streaks
       ORDER BY longest_streak DESC, total_wins DESC, updated_at ASC
       LIMIT $1`,
      [safeLimit],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      rank: r.rank,
      currentStreak: r.current_streak,
      longestStreak: r.longest_streak,
      totalWins: r.total_wins,
    }));
  }
}

export const engagementService = new EngagementService();
// BANKERCHANGER — Engagement / Gamification Service
// ============================================================
// Single in-memory service (mirrors the style of user.service.ts)
// backing four engagement surfaces:
//
//   1. Prediction streaks   — recordPredictionResult / getStreak
//   2. Achievement badges    — awarded as a side effect, getBadges
//   3. Referral tree         — registerReferral / getReferralTree
//   4. Referral payouts      — recordReferralFee / computeReferralPayouts
//   5. Leaderboard + ranks   — addPoints / getLeaderboard, emits RankUpdate
//
// The leaderboard exposes a listener hook so the WebSocket layer can
// broadcast real-time rank changes without this service importing `ws`.
// ============================================================

import { AppError } from '../utils/AppError';
import type {
  Badge,
  BadgeCode,
  LeaderboardEntry,
  RankUpdate,
  ReferralNode,
  ReferralPayout,
  StreakState,
} from '../models/Engagement';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Commission rate applied to a downline's platform fees, indexed by level. */
const REFERRAL_RATES: Record<1 | 2 | 3, number> = {
  1: 0.1, // direct referral
  2: 0.05, // referral of a referral
  3: 0.025, // third level
};

const MAX_REFERRAL_DEPTH = 3;

const BADGE_META: Record<BadgeCode, { label: string; description: string }> = {
  first_win: { label: 'First Blood', description: 'Landed your first correct prediction.' },
  streak_3: { label: 'On a Roll', description: 'Reached a 3-prediction winning streak.' },
  streak_5: { label: 'Heating Up', description: 'Reached a 5-prediction winning streak.' },
  streak_10: { label: 'Unstoppable', description: 'Reached a 10-prediction winning streak.' },
  sharpshooter: { label: 'Sharpshooter', description: 'Accumulated 25 correct predictions.' },
  referral_starter: { label: 'Recruiter', description: 'Referred your first active user.' },
  referral_captain: { label: 'Referral Captain', description: 'Referred 5 users.' },
  top_10: { label: 'Top 10', description: 'Broke into the top 10 of the leaderboard.' },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface EngagementRecord {
  streak: StreakState;
  badges: Map<BadgeCode, Badge>;
  /** Direct referrals made by this user (referee userIds). */
  referrals: Set<string>;
  /** The user who referred this user, if any. */
  referredBy: string | null;
  /** Platform fees this user has generated that feed referral payouts. */
  feesGenerated: number;
  /** Referral commission credited to this user, all-time. */
  referralEarnings: number;
  points: number;
}

type RankListener = (updates: RankUpdate[]) => void;

class EngagementService {
  private records = new Map<string, EngagementRecord>();
  /** Cached rank per user from the last recompute, for change detection. */
  private ranks = new Map<string, number>();
  private rankListener: RankListener | null = null;

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private record(userId: string): EngagementRecord {
    if (!userId || typeof userId !== 'string') {
      throw new AppError(400, 'A valid userId is required');
    }
    let rec = this.records.get(userId);
    if (!rec) {
      rec = {
        streak: {
          userId,
          current: 0,
          longest: 0,
          totalWins: 0,
          totalSettled: 0,
          lastResultAt: null,
        },
        badges: new Map(),
        referrals: new Set(),
        referredBy: null,
        feesGenerated: 0,
        referralEarnings: 0,
        points: 0,
      };
      this.records.set(userId, rec);
    }
    return rec;
  }

  private award(userId: string, code: BadgeCode, awarded: Badge[]): void {
    const rec = this.record(userId);
    if (rec.badges.has(code)) return;
    const badge: Badge = {
      code,
      label: BADGE_META[code].label,
      description: BADGE_META[code].description,
      awardedAt: new Date().toISOString(),
    };
    rec.badges.set(code, badge);
    awarded.push(badge);
  }

  // -------------------------------------------------------------------------
  // 1 + 2. Streaks & badges
  // -------------------------------------------------------------------------

  /**
   * Record the outcome of a settled prediction for a user and return the
   * updated streak plus any badges newly unlocked by this result.
   */
  recordPredictionResult(userId: string, won: boolean): { streak: StreakState; newBadges: Badge[] } {
    const rec = this.record(userId);
    const s = rec.streak;
    const newBadges: Badge[] = [];

    s.totalSettled += 1;
    s.lastResultAt = new Date().toISOString();

    if (won) {
      s.current += 1;
      s.totalWins += 1;
      if (s.current > s.longest) s.longest = s.current;

      if (s.totalWins === 1) this.award(userId, 'first_win', newBadges);
      if (s.current >= 3) this.award(userId, 'streak_3', newBadges);
      if (s.current >= 5) this.award(userId, 'streak_5', newBadges);
      if (s.current >= 10) this.award(userId, 'streak_10', newBadges);
      if (s.totalWins >= 25) this.award(userId, 'sharpshooter', newBadges);
    } else {
      s.current = 0;
    }

    return { streak: { ...s }, newBadges };
  }

  getStreak(userId: string): StreakState {
    return { ...this.record(userId).streak };
  }

  getBadges(userId: string): Badge[] {
    return [...this.record(userId).badges.values()].sort((a, b) =>
      a.awardedAt.localeCompare(b.awardedAt),
    );
  }

  // -------------------------------------------------------------------------
  // 3. Referral tree
  // -------------------------------------------------------------------------

  /**
   * Link `refereeUserId` under `referrerUserId`. A referee may only ever have
   * one referrer, cannot refer themselves, and cannot create a cycle in the
   * referral graph.
   */
  registerReferral(referrerUserId: string, refereeUserId: string): void {
    const referrer = this.record(referrerUserId);
    const referee = this.record(refereeUserId);

    if (referrerUserId === refereeUserId) {
      throw new AppError(400, 'A user cannot refer themselves');
    }
    if (referee.referredBy && referee.referredBy !== referrerUserId) {
      throw new AppError(409, 'User has already been referred by someone else');
    }
    if (referee.referredBy === referrerUserId) return; // idempotent

    // Cycle guard: referrer must not already be somewhere in referee's downline.
    if (this.isInDownline(refereeUserId, referrerUserId)) {
      throw new AppError(409, 'Referral would create a cycle');
    }

    referee.referredBy = referrerUserId;
    referrer.referrals.add(refereeUserId);

    const badges: Badge[] = [];
    if (referrer.referrals.size >= 1) this.award(referrerUserId, 'referral_starter', badges);
    if (referrer.referrals.size >= 5) this.award(referrerUserId, 'referral_captain', badges);
  }

  private isInDownline(rootUserId: string, candidateUserId: string): boolean {
    const stack = [...this.record(rootUserId).referrals];
    const seen = new Set<string>();
    while (stack.length) {
      const next = stack.pop()!;
      if (next === candidateUserId) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      const rec = this.records.get(next);
      if (rec) stack.push(...rec.referrals);
    }
    return false;
  }

  getDirectReferrals(userId: string): string[] {
    return [...this.record(userId).referrals];
  }

  /** Build the downline tree for `userId`, capped at {@link MAX_REFERRAL_DEPTH}. */
  getReferralTree(userId: string, maxDepth: number = MAX_REFERRAL_DEPTH): ReferralNode {
    const build = (id: string, depth: number, seen: Set<string>): ReferralNode => {
      const rec = this.record(id);
      seen.add(id);
      const children: ReferralNode[] =
        depth >= maxDepth
          ? []
          : [...rec.referrals]
              .filter((child) => !seen.has(child))
              .map((child) => build(child, depth + 1, seen));
      return { userId: id, depth, feesGenerated: rec.feesGenerated, children };
    };
    return build(userId, 0, new Set());
  }

  // -------------------------------------------------------------------------
  // 4. Referral payouts
  // -------------------------------------------------------------------------

  /**
   * Record that `refereeUserId` generated `feeAmount` of platform fees and
   * credit multi-level referral commission up their ancestor chain.
   * Returns the payouts that were credited by this call.
   */
  recordReferralFee(refereeUserId: string, feeAmount: number): ReferralPayout[] {
    if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
      throw new AppError(400, 'feeAmount must be a positive number');
    }
    const referee = this.record(refereeUserId);
    referee.feesGenerated += feeAmount;

    const payouts: ReferralPayout[] = [];
    let ancestorId = referee.referredBy;
    let level: 1 | 2 | 3 = 1;

    while (ancestorId && level <= MAX_REFERRAL_DEPTH) {
      const ancestor = this.record(ancestorId);
      const amount = round2(feeAmount * REFERRAL_RATES[level]);
      if (amount > 0) {
        ancestor.referralEarnings = round2(ancestor.referralEarnings + amount);
        payouts.push({ level, fromUserId: refereeUserId, amount });
      }
      ancestorId = ancestor.referredBy;
      level = (level + 1) as 1 | 2 | 3;
    }
    return payouts;
  }

  /**
   * Compute — without mutating state — the referral payouts `userId` would earn
   * from the fees currently attributed to their downline.
   */
  computeReferralPayouts(userId: string): ReferralPayout[] {
    this.record(userId);
    const payouts: ReferralPayout[] = [];

    const walk = (id: string, level: number): void => {
      if (level > MAX_REFERRAL_DEPTH) return;
      const rec = this.records.get(id);
      if (!rec) return;
      for (const childId of rec.referrals) {
        const child = this.records.get(childId);
        if (!child) continue;
        const rate = REFERRAL_RATES[level as 1 | 2 | 3];
        const amount = round2(child.feesGenerated * rate);
        if (amount > 0) {
          payouts.push({ level: level as 1 | 2 | 3, fromUserId: childId, amount });
        }
        walk(childId, level + 1);
      }
    };

    walk(userId, 1);
    return payouts;
  }

  getReferralEarnings(userId: string): number {
    return this.record(userId).referralEarnings;
  }

  // -------------------------------------------------------------------------
  // 5. Leaderboard & real-time rank updates
  // -------------------------------------------------------------------------

  /** Register the callback invoked with rank changes after every recompute. */
  setRankUpdateListener(listener: RankListener | null): void {
    this.rankListener = listener;
  }

  /**
   * Add `points` to a user's leaderboard score, recompute ranks, and emit
   * a RankUpdate for every user whose rank changed as a result.
   */
  addPoints(userId: string, points: number): RankUpdate[] {
    if (!Number.isFinite(points) || points <= 0) {
      throw new AppError(400, 'points must be a positive number');
    }
    const rec = this.record(userId);
    rec.points += points;
    return this.recomputeRanks();
  }

  private recomputeRanks(): RankUpdate[] {
    const ordered = [...this.records.entries()]
      .filter(([, rec]) => rec.points > 0)
      .sort((a, b) => b[1].points - a[1].points || a[0].localeCompare(b[0]));

    const updates: RankUpdate[] = [];
    const nextRanks = new Map<string, number>();

    ordered.forEach(([id, rec], index) => {
      const newRank = index + 1;
      nextRanks.set(id, newRank);
      const previousRank = this.ranks.get(id) ?? null;
      if (previousRank !== newRank) {
        updates.push({
          userId: id,
          previousRank,
          newRank,
          points: rec.points,
          direction: previousRank === null || newRank < previousRank ? 'up' : 'down',
        });
        if (newRank <= 10) {
          this.award(id, 'top_10', []);
        }
      }
    });

    this.ranks = nextRanks;
    if (updates.length && this.rankListener) {
      try {
        this.rankListener(updates);
      } catch {
        // A failing listener must never corrupt leaderboard state.
      }
    }
    return updates;
  }

  getLeaderboard(limit = 100): LeaderboardEntry[] {
    return [...this.records.entries()]
      .filter(([, rec]) => rec.points > 0)
      .sort((a, b) => b[1].points - a[1].points || a[0].localeCompare(b[0]))
      .slice(0, Math.max(0, limit))
      .map(([userId, rec], index) => ({ userId, points: rec.points, rank: index + 1 }));
  }

  getRank(userId: string): number | null {
    return this.ranks.get(userId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Test helper
  // -------------------------------------------------------------------------

  /** @internal Reset all in-memory state — used by tests. */
  __reset(): void {
    this.records.clear();
    this.ranks.clear();
    this.rankListener = null;
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export const engagementService = new EngagementService();
export { EngagementService };
import { getActivityFeed, type LeaderboardRankUpdateEvent } from '../websocket/realtime';

export type PredictionBadge = {
  code: string;
  label: string;
  description: string;
};

export type UserEngagementStats = {
  totalPredictions: number;
  totalWins: number;
  totalLosses: number;
  currentStreak: number;
  longestStreak: number;
  lastOutcome: boolean | null;
};

export type ReferralNode = {
  userId: string;
  referrals: ReferralNode[];
};

export type ReferralTreeSummary = {
  totalReferrals: number;
  depth: number;
  users: string[];
};

export type ReferralPayoutBreakdown = {
  level: number;
  userId: string;
  amount: number;
};

export type ReferralPayoutResult = {
  total: number;
  breakdown: ReferralPayoutBreakdown[];
};

export class EngagementService {
  private predictionStats = new Map<string, UserEngagementStats>();
  private ownedBadges = new Map<string, Set<string>>();
  private referralGraph = new Map<string, Set<string>>();
  private feed: { publishLeaderboardUpdate: (event: LeaderboardRankUpdateEvent) => void } | null;

  constructor(feed?: { publishLeaderboardUpdate: (event: LeaderboardRankUpdateEvent) => void }) {
    this.feed = feed ?? null;
  }

  recordPredictionResult(userId: string, wasCorrect: boolean): UserEngagementStats {
    const stats = this.predictionStats.get(userId) ?? {
      totalPredictions: 0,
      totalWins: 0,
      totalLosses: 0,
      currentStreak: 0,
      longestStreak: 0,
      lastOutcome: null,
    };

    stats.totalPredictions += 1;
    if (wasCorrect) {
      stats.totalWins += 1;
      stats.currentStreak += 1;
      stats.lastOutcome = true;
    } else {
      stats.totalLosses += 1;
      stats.currentStreak = 0;
      stats.lastOutcome = false;
    }

    stats.longestStreak = Math.max(stats.longestStreak, stats.currentStreak);
    this.predictionStats.set(userId, stats);
    this.syncBadges(userId);
    return { ...stats };
  }

  getUserStats(userId: string): UserEngagementStats {
    return { ...(this.predictionStats.get(userId) ?? {
      totalPredictions: 0,
      totalWins: 0,
      totalLosses: 0,
      currentStreak: 0,
      longestStreak: 0,
      lastOutcome: null,
    }) };
  }

  getUserBadges(userId: string): PredictionBadge[] {
    const codes = this.ownedBadges.get(userId) ?? new Set<string>();
    return [...codes].map((code) => this.badgeMeta(code)).filter(Boolean) as PredictionBadge[];
  }

  trackReferral(referrerUserId: string, referredUserId: string): void {
    if (!this.referralGraph.has(referrerUserId)) {
      this.referralGraph.set(referrerUserId, new Set());
    }
    this.referralGraph.get(referrerUserId)!.add(referredUserId);
  }

  getReferralTree(referrerUserId: string): ReferralTreeSummary {
    const seen = new Set<string>();
    const users: string[] = [];
    const walk = (current: string, depth: number): number => {
      const children = this.referralGraph.get(current) ?? new Set<string>();
      let maxDepth = depth;

      for (const child of children) {
        if (seen.has(child)) continue;
        seen.add(child);
        users.push(child);
        maxDepth = Math.max(maxDepth, walk(child, depth + 1));
      }

      return maxDepth;
    };

    const rootDepth = walk(referrerUserId, 0);
    return {
      totalReferrals: users.length,
      depth: Math.max(rootDepth, 0),
      users: [referrerUserId, ...users],
    };
  }

  calculateReferralPayout(referrerUserId: string): ReferralPayoutResult {
    const tree = this.getReferralTree(referrerUserId);
    const breakdown: ReferralPayoutBreakdown[] = [];
    const levelCounts = new Map<number, number>();

    const countReferralsAtLevel = (current: string, currentLevel: number, visited: Set<string>): void => {
      if (visited.has(current)) return;
      visited.add(current);

      if (currentLevel > 0) {
        levelCounts.set(currentLevel, (levelCounts.get(currentLevel) ?? 0) + 1);
      }

      const children = this.referralGraph.get(current) ?? new Set<string>();
      for (const child of children) {
        countReferralsAtLevel(child, currentLevel + 1, visited);
      }
    };

    countReferralsAtLevel(referrerUserId, 0, new Set());

    // Calculate payout: level 1 = 10%, level 2 = 5%, level 3+ = 2%
    for (const [level, count] of levelCounts.entries()) {
      if (level === 0) continue; // skip root
      const rate = level === 1 ? 0.1 : level === 2 ? 0.05 : 0.02;
      const amount = Number((count * rate).toFixed(2));
      if (amount > 0) {
        breakdown.push({ level, userId: referrerUserId, amount });
      }
    }

    const total = Number((breakdown.reduce((sum, entry) => sum + entry.amount, 0)).toFixed(2));
    return { total, breakdown };
  }

  publishLeaderboardUpdate(params: {
    userId: string;
    rank: number;
    leaderboardId: string;
    score: number;
    displayName?: string;
  }): void {
    const event: LeaderboardRankUpdateEvent = {
      type: 'leaderboard_rank_update',
      leaderboardId: params.leaderboardId,
      userId: params.userId,
      rank: params.rank,
      score: params.score,
      displayName: params.displayName,
      timestamp: new Date().toISOString(),
    };

    if (this.feed) {
      this.feed.publishLeaderboardUpdate(event);
      return;
    }

    try {
      getActivityFeed().publishLeaderboardUpdate(event);
    } catch {
      // no-op when no feed is initialized
    }
  }

  private syncBadges(userId: string): void {
    const stats = this.getUserStats(userId);
    const badges = this.ownedBadges.get(userId) ?? new Set<string>();

    if (stats.totalWins >= 3) badges.add('predictor');
    if (stats.currentStreak >= 3) badges.add('streak_3');
    if (stats.currentStreak >= 5) badges.add('streak_5');
    if (stats.totalWins >= 10) badges.add('hot_streak');

    this.ownedBadges.set(userId, badges);
  }

  private badgeMeta(code: string): PredictionBadge | null {
    const map: Record<string, PredictionBadge> = {
      predictor: { code: 'predictor', label: 'Predictor', description: 'Won 3 predictions' },
      streak_3: { code: 'streak_3', label: '3-Win Streak', description: 'Reached a three-win streak' },
      streak_5: { code: 'streak_5', label: 'Hot Streak', description: 'Reached a five-win streak' },
      hot_streak: { code: 'hot_streak', label: 'Hot Streak', description: 'Won 10 predictions' },
    };

    return map[code] ?? null;
  }
}
