// ============================================================
// BANKERCHANGER — Engagement / Gamification Models
// Covers prediction streaks, achievement badges, the referral
// tree + payout calculations, and leaderboard rank tracking.
// ============================================================

/** Rolling state of a user's correct-prediction streak. */
export interface StreakState {
  userId: string;
  /** Consecutive correct predictions ending with the most recent result. */
  current: number;
  /** Best streak the user has ever reached. */
  longest: number;
  /** Total correct predictions, all-time. */
  totalWins: number;
  /** Total predictions settled (correct + incorrect). */
  totalSettled: number;
  /** ISO timestamp of the most recently settled prediction, null if none. */
  lastResultAt: string | null;
}

/** A unique achievement a user can unlock exactly once. */
export interface Badge {
  code: BadgeCode;
  label: string;
  description: string;
  /** ISO timestamp the badge was awarded. */
  awardedAt: string;
}

export type BadgeCode =
  | 'first_win'
  | 'streak_3'
  | 'streak_5'
  | 'streak_10'
  | 'sharpshooter'
  | 'referral_starter'
  | 'referral_captain'
  | 'top_10';

/** One credited slice of a multi-level referral payout. */
export interface ReferralPayout {
  /** 1 = direct referral, 2 = referral-of-referral, 3 = third level. */
  level: 1 | 2 | 3;
  /** The downline user whose platform fees generated this payout. */
  fromUserId: string;
  /** Commission amount, in the same unit as the fee that was recorded. */
  amount: number;
}

/** A node in a user's downline referral tree. */
export interface ReferralNode {
  userId: string;
  /** Depth relative to the tree root (root = 0). */
  depth: number;
  /** Platform fees this user has generated that count toward referral payouts. */
  feesGenerated: number;
  children: ReferralNode[];
}

/** A single row of the leaderboard. */
export interface LeaderboardEntry {
  userId: string;
  points: number;
  rank: number;
}

/** Emitted when a user's leaderboard rank changes. */
export interface RankUpdate {
  userId: string;
  previousRank: number | null;
  newRank: number;
  points: number;
  /** 'up' when the numeric rank decreased (closer to #1), 'down' otherwise. */
  direction: 'up' | 'down';
}
