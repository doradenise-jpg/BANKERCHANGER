// ============================================================
// BANKERCHANGER — Engagement Service
// Gamification & Notifications:
//   * user prediction streaks + achievement badges
//   * referral tree tracking + payout calculations
//   * real-time leaderboard rank updates via WebSocket
// ============================================================

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
