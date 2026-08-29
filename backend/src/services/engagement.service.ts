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
