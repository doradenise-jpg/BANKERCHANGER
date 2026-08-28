// ============================================================
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
