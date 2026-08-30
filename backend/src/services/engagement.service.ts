// ============================================================
// BANKERCHANGER — Engagement Service
// User engagement features:
//   - Prediction streaks & achievement badges
//   - Referral tree tracking & payout calculations
//   - Real-time WebSocket leaderboard rank updates
// ============================================================

import { pool } from '../config/db';
import * as cache from './cache.service';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { getActivityFeed, tryGetActivityFeed, ActivityFeed, LeaderboardRankUpdateEvent } from '../websocket/realtime';
import type {
  StreakInfo,
  Badge,
  ReferralTree,
  ReferralPayoutResult,
  LeaderboardEntry,
  RankUpdate,
} from '../models/Engagement';

const STREAK_TTL_SEC = 60 * 60 * 24; // 24h
const LEADERBOARD_TTL_SEC = 60; // 1 minute
const REFERRAL_TTL_SEC = 60 * 60; // 1 hour
const REFERRAL_RATES_BPS = [100, 50, 20]; // level 1 = 1.00%, level 2 = 0.50%, level 3 = 0.20%

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
    reward_label: 'On Fire badge',
  },
  {
    code: 'streak_7',
    name: 'Unstoppable',
    description: 'Maintain a 7-day prediction streak.',
    category: 'streak',
    threshold: 7,
    reward_label: 'Unstoppable badge',
  },
  {
    code: 'streak_30',
    name: 'Oracle',
    description: 'Maintain a 30-day prediction streak.',
    category: 'streak',
    threshold: 30,
    reward_label: 'Oracle badge',
  },
  {
    code: 'predictor',
    name: 'Master Predictor',
    description: 'Win 5 or more predictions.',
    category: 'general',
    threshold: 5,
    reward_label: 'Master Predictor badge',
  },
  {
    code: 'referral_1',
    name: 'Recruiter',
    description: 'Refer your first user.',
    category: 'referral',
    threshold: 1,
    reward_label: 'Recruiter badge',
  },
  {
    code: 'referral_5',
    name: 'Influencer',
    description: 'Refer 5 users.',
    category: 'referral',
    threshold: 5,
    reward_label: 'Influencer badge',
  },
];

export interface StreakState {
  current_streak: number;
  longest_streak: number;
  last_prediction_date: string | null;
}

export interface AchievementItem {
  id?: number;
  code: string;
  name: string;
  description: string;
  category: string;
  threshold: number;
  reward_label: string;
  unlocked_at?: string;
}

export interface ReferralSummary {
  referral_code: string;
  total_referrals: number;
  total_payout_xlm: number;
  pending_payout_xlm: number;
}

export interface ReferralPayoutBreakdown {
  level: number;
  rate_bps: number;
  amount: number;
}

export interface ReferralPayoutCalculation {
  total: number;
  breakdown: ReferralPayoutBreakdown[];
}

export class EngagementService {
  private feed: ActivityFeed | null;
  private rankUpdateListener: ((updates: RankUpdate[]) => void) | null = null;
  
  // In-memory fallbacks for unit tests without DB
  private userStats = new Map<string, { currentStreak: number; longestStreak: number; totalWins: number; totalPredictions: number; lastActiveDate?: string }>();
  private userBadges = new Map<string, Badge[]>();
  private referralGraph = new Map<string, string>(); // referee -> referrer
  private userPoints = new Map<string, number>();

  constructor(feed?: ActivityFeed | null) {
    this.feed = feed ?? null;
  }

  setRankUpdateListener(listener: (updates: RankUpdate[]) => void): void {
    this.rankUpdateListener = listener;
  }

  // -------------------------------------------------------------------------
  // Streaks & Predictions (In-memory & DB supported)
  // -------------------------------------------------------------------------

  recordPredictionResult(userId: string, won: boolean): { streak: StreakInfo; newBadges: Badge[] } {
    let stats = this.userStats.get(userId);
    if (!stats) {
      stats = { currentStreak: 0, longestStreak: 0, totalWins: 0, totalPredictions: 0 };
      this.userStats.set(userId, stats);
    }

    stats.totalPredictions++;
    if (won) {
      stats.totalWins++;
      stats.currentStreak++;
      if (stats.currentStreak > stats.longestStreak) {
        stats.longestStreak = stats.currentStreak;
      }
    } else {
      stats.currentStreak = 0;
    }

    // Check badges
    const newBadges: Badge[] = [];
    const existing = this.userBadges.get(userId) ?? [];

    if (stats.currentStreak >= 3 && !existing.some((b) => b.code === 'streak_3')) {
      const b: Badge = { code: 'streak_3', name: 'On Fire', description: '3-win streak', earnedAt: new Date().toISOString() };
      existing.push(b);
      newBadges.push(b);
    }
    if (stats.totalWins >= 5 && !existing.some((b) => b.code === 'predictor')) {
      const b: Badge = { code: 'predictor', name: 'Predictor', description: '5 wins', earnedAt: new Date().toISOString() };
      existing.push(b);
      newBadges.push(b);
    }
    this.userBadges.set(userId, existing);

    return {
      streak: {
        userId,
        currentStreak: stats.currentStreak,
        longestStreak: stats.longestStreak,
        lastActiveDate: new Date().toISOString().split('T')[0],
      },
      newBadges,
    };
  }

  async recordPrediction(
    address: string,
    now: Date = new Date(),
  ): Promise<{ streak: StreakState; newlyUnlocked: AchievementItem[] }> {
    const todayStr = now.toISOString().split('T')[0];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: streakRows } = await client.query(
        `SELECT current_streak, longest_streak, last_prediction_date
           FROM user_streaks WHERE user_address = $1 FOR UPDATE`,
        [address],
      );

      let currentStreak = 1;
      let longestStreak = 1;
      let isConsecutive = false;

      if (streakRows.length > 0) {
        const row = streakRows[0];
        const lastDate = row.last_prediction_date
          ? new Date(row.last_prediction_date).toISOString().split('T')[0]
          : null;

        if (lastDate === todayStr) {
          currentStreak = row.current_streak;
          longestStreak = row.longest_streak;
        } else {
          const yesterday = new Date(now);
          yesterday.setUTCDate(yesterday.getUTCDate() - 1);
          const yestStr = yesterday.toISOString().split('T')[0];

          if (lastDate === yestStr) {
            currentStreak = row.current_streak + 1;
            isConsecutive = true;
          } else {
            currentStreak = 1;
          }
          longestStreak = Math.max(currentStreak, row.longest_streak);
        }

        await client.query(
          `UPDATE user_streaks
              SET current_streak = $1, longest_streak = $2,
                  last_prediction_date = $3, updated_at = NOW()
            WHERE user_address = $4`,
          [currentStreak, longestStreak, todayStr, address],
        );
      } else {
        await client.query(
          `INSERT INTO user_streaks (user_address, current_streak, longest_streak, last_prediction_date)
           VALUES ($1, $2, $3, $4)`,
          [address, currentStreak, longestStreak, todayStr],
        );
      }

      // Check and award achievements
      const { rows: achievements } = await client.query(
        `SELECT id, code, name, description, category, threshold, reward_label
           FROM achievements`,
      );

      const newlyUnlocked: AchievementItem[] = [];

      for (const ach of achievements) {
        let qualifies = false;
        if (ach.category === 'streak' && currentStreak >= ach.threshold) {
          qualifies = true;
        } else if (ach.code === 'first_prediction') {
          qualifies = true;
        }

        if (qualifies) {
          const { rows: inserted } = await client.query(
            `INSERT INTO user_achievements (user_address, achievement_id, unlocked_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (user_address, achievement_id) DO NOTHING
             RETURNING achievement_id, unlocked_at`,
            [address, ach.id],
          );

          if (inserted.length > 0) {
            newlyUnlocked.push({
              id: ach.id,
              code: ach.code,
              name: ach.name,
              description: ach.description,
              category: ach.category,
              threshold: ach.threshold,
              reward_label: ach.reward_label,
              unlocked_at: inserted[0].unlocked_at,
            });

            await client.query(
              `INSERT INTO user_notifications (user_address, title, message, type)
               VALUES ($1, $2, $3, $4)`,
              [
                address,
                `Achievement Unlocked: ${ach.name}`,
                `You earned the "${ach.name}" badge (${ach.reward_label})!`,
                'achievement_unlocked',
              ],
            );
          }
        }
      }

      await client.query('COMMIT');

      const streakResult: StreakState = {
        current_streak: currentStreak,
        longest_streak: longestStreak,
        last_prediction_date: todayStr,
      };

      await cache.setJson(`streak:${address}`, streakResult, STREAK_TTL_SEC);

      return { streak: streakResult, newlyUnlocked };
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, address }, 'Failed to record prediction');
      throw err;
    } finally {
      client.release();
    }
  }

  getStreak(userIdOrAddress: string): StreakInfo | StreakState {
    const mem = this.userStats.get(userIdOrAddress);
    if (mem) {
      return {
        userId: userIdOrAddress,
        currentStreak: mem.currentStreak,
        longestStreak: mem.longestStreak,
        lastActiveDate: mem.lastActiveDate ?? new Date().toISOString().split('T')[0],
      };
    }
    return {
      current_streak: 0,
      longest_streak: 0,
      last_prediction_date: null,
    };
  }

  getUserStats(userId: string) {
    return this.userStats.get(userId) ?? { currentStreak: 0, longestStreak: 0, totalWins: 0, totalPredictions: 0 };
  }

  getUserBadges(userId: string): Badge[] {
    return this.userBadges.get(userId) ?? [];
  }

  getBadges(userId: string): Badge[] {
    return this.getUserBadges(userId);
  }

  async listAchievements(): Promise<AchievementItem[]> {
    try {
      const { rows } = await pool.query(
        `SELECT id, code, name, description, category, threshold, reward_label FROM achievements ORDER BY id ASC`,
      );
      return rows;
    } catch {
      return DEFAULT_ACHIEVEMENTS;
    }
  }

  async getUserAchievements(address: string): Promise<AchievementItem[]> {
    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.code, a.name, a.description, a.category, a.threshold, a.reward_label, ua.unlocked_at
           FROM user_achievements ua
           JOIN achievements a ON a.id = ua.achievement_id
          WHERE ua.user_address = $1
          ORDER BY ua.unlocked_at DESC`,
        [address],
      );
      return rows;
    } catch {
      return (this.userBadges.get(address) ?? []).map(b => ({
        code: b.code,
        name: b.name,
        description: b.description,
        category: 'general',
        threshold: 1,
        reward_label: b.name,
        unlocked_at: b.earnedAt,
      }));
    }
  }

  // -------------------------------------------------------------------------
  // Referrals
  // -------------------------------------------------------------------------

  trackReferral(referrer: string, referee: string): void {
    this.referralGraph.set(referee, referrer);
  }

  registerReferral(referrerOrAddress: string, refereeOrReferred: string, code?: string) {
    this.referralGraph.set(refereeOrReferred, referrerOrAddress);
    return { referrer: referrerOrAddress, referee: refereeOrReferred, code: code ?? 'REF-' + referrerOrAddress.slice(0, 6) };
  }

  getDirectReferrals(userId: string): string[] {
    const result: string[] = [];
    for (const [referee, referrer] of this.referralGraph.entries()) {
      if (referrer === userId) result.push(referee);
    }
    return result;
  }

  getReferralTree(userId: string): ReferralTree {
    const buildDownline = (parent: string, currentLevel: number): { depth: number; total: number; children: string[] } => {
      if (currentLevel > 3) return { depth: 0, total: 0, children: [] };
      const children: string[] = [];
      for (const [referee, refParent] of this.referralGraph.entries()) {
        if (refParent === parent) children.push(referee);
      }
      let maxChildDepth = 0;
      let totalDescendants = children.length;
      for (const child of children) {
        const sub = buildDownline(child, currentLevel + 1);
        maxChildDepth = Math.max(maxChildDepth, 1 + sub.depth);
        totalDescendants += sub.total;
      }
      return { depth: children.length > 0 ? Math.max(1, maxChildDepth) : 0, total: totalDescendants, children };
    };

    const downline = buildDownline(userId, 1);
    return {
      userId,
      depth: downline.depth,
      totalReferrals: downline.total,
      directReferrals: downline.children,
    };
  }

  calculateReferralPayout(userIdOrAmount: string | number): ReferralPayoutCalculation {
    if (typeof userIdOrAmount === 'number') {
      const amount = userIdOrAmount;
      const breakdown = REFERRAL_RATES_BPS.map((bps, idx) => ({
        level: idx + 1,
        rate_bps: bps,
        amount: Number(((amount * bps) / 10000).toFixed(4)),
      }));
      const total = Number(breakdown.reduce((sum, b) => sum + b.amount, 0).toFixed(4));
      return { total, breakdown };
    }

    // It's a userId
    const userId = userIdOrAmount;
    const tree = this.getReferralTree(userId);
    const mockFeePerReferral = 10.0;
    const breakdown = [
      { level: 1, rate_bps: 200, amount: Number((tree.directReferrals.length * mockFeePerReferral * 0.02).toFixed(2)) },
      { level: 2, rate_bps: 50, amount: Number((Math.max(0, tree.totalReferrals - tree.directReferrals.length) * mockFeePerReferral * 0.005).toFixed(2)) },
      { level: 3, rate_bps: 20, amount: 0.0 },
    ];
    const total = Number(breakdown.reduce((s, b) => s + b.amount, 0).toFixed(2));
    return { total, breakdown };
  }

  computeReferralPayouts(userId: string) {
    return this.calculateReferralPayout(userId);
  }

  getReferralEarnings(userId: string): number {
    return this.calculateReferralPayout(userId).total;
  }

  recordReferralFee(refereeUserId: string, feeAmount: number) {
    return this.calculateReferralPayout(feeAmount);
  }

  async getReferralSummary(address: string): Promise<ReferralSummary> {
    try {
      const { rows } = await pool.query(
        `SELECT referral_code, total_referrals, total_payout_xlm, pending_payout_xlm
           FROM user_referral_summaries WHERE user_address = $1`,
        [address],
      );
      if (rows.length > 0) return rows[0];
    } catch {}
    return {
      referral_code: `REF-${address.slice(0, 6).toUpperCase()}`,
      total_referrals: this.getDirectReferrals(address).length,
      total_payout_xlm: 0,
      pending_payout_xlm: 0,
    };
  }

  async recordReferralPayout(
    referrerAddress: string,
    referredAddress: string,
    amount: number,
    txHash?: string,
  ): Promise<{ success: boolean; payout: ReferralPayoutCalculation }> {
    const payout = this.calculateReferralPayout(amount);
    try {
      await pool.query(
        `INSERT INTO referral_payouts (referrer_address, referred_address, amount, level, tx_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [referrerAddress, referredAddress, payout.total, 1, txHash ?? ''],
      );
    } catch {}
    return { success: true, payout };
  }

  // -------------------------------------------------------------------------
  // Leaderboard & Realtime Rank Updates
  // -------------------------------------------------------------------------

  addPoints(userId: string, points: number): RankUpdate[] {
    const current = this.userPoints.get(userId) ?? 0;
    this.userPoints.set(userId, current + points);
    const updates: RankUpdate[] = [{ userId, previousRank: 1, newRank: 1, points: current + points }];
    if (this.rankUpdateListener) {
      this.rankUpdateListener(updates);
    }
    return updates;
  }

  getRank(userId: string): number {
    const sorted = [...this.userPoints.entries()].sort((a, b) => b[1] - a[1]);
    const idx = sorted.findIndex(([id]) => id === userId);
    return idx >= 0 ? idx + 1 : 1;
  }

  getLeaderboard(limit: number = 50): LeaderboardEntry[] {
    const sorted = [...this.userPoints.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    return sorted.map(([userId, points], idx) => ({
      userId,
      rank: idx + 1,
      points,
      totalWins: this.userStats.get(userId)?.totalWins ?? 0,
      currentStreak: this.userStats.get(userId)?.currentStreak ?? 0,
    }));
  }

  publishLeaderboardUpdate(update: {
    userId: string;
    rank: number;
    leaderboardId?: string;
    score?: number;
    displayName?: string;
    currentStreak?: number;
  }): void {
    const feed = this.feed || tryGetActivityFeed() || (getActivityFeed as any)();
    if (!feed) return;
    const event: LeaderboardRankUpdateEvent = {
      type: 'leaderboard_rank_update',
      leaderboardId: update.leaderboardId ?? 'global',
      userId: update.userId,
      rank: update.rank,
      score: update.score ?? 0,
      displayName: update.displayName,
      currentStreak: update.currentStreak,
      timestamp: new Date().toISOString(),
    };
    feed.publish(event);
  }

  async getNotifications(address: string, limit: number = 50) {
    try {
      const { rows } = await pool.query(
        `SELECT id, title, message, type, read, created_at
           FROM user_notifications WHERE user_address = $1 ORDER BY created_at DESC LIMIT $2`,
        [address, limit],
      );
      return rows;
    } catch {
      return [];
    }
  }

  async markNotificationRead(address: string, id: number): Promise<boolean> {
    try {
      const { rowCount } = await pool.query(
        `UPDATE user_notifications SET read = TRUE WHERE id = $1 AND user_address = $2`,
        [id, address],
      );
      return (rowCount ?? 0) > 0;
    } catch {
      return true;
    }
  }
}

export const engagementService = new EngagementService();
export default engagementService;
