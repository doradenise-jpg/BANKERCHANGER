// ============================================================
// BANKERCHANGER — Engagement Service Unit Tests
// Covers streaks, achievements, referrals, and leaderboard logic.
// ============================================================

import * as Engagement from '../../src/services/engagement.service';
import { pool } from '../../src/config/db';
import * as cache from '../../src/services/cache.service';
import { getActivityFeed } from '../../src/websocket/realtime';

// ── Mocks ────────────────────────────────────────────────────────────────────
let mockPoolQuery: jest.Mock;

jest.mock('../../src/config/db', () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('../../src/services/cache.service', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
  delPattern: jest.fn().mockResolvedValue(undefined),
  getOrSet: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/websocket/realtime', () => ({
  getActivityFeed: jest.fn(() => ({ publish: jest.fn() })),
}));

const mockPool = pool.query as jest.Mock;
const mockFeedPublish = (getActivityFeed() as unknown as { publish: jest.Mock }).publish;

describe('Engagement Service', () => {
  const ADDRESS = 'GBXPZMXTK4WZHCXZASP7F3VW3JZOZXZ6V7ZRNBXKF6VPVDPF56IHTLFO';

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool.mockReset();
  });

  describe('getOrInitStreak', () => {
    it('returns a new streak row when none exists', async () => {
      mockPool
        .mockResolvedValueOnce({ rows: [{
          address: ADDRESS, current_streak: 0, best_streak: 0,
          total_predictions: 0, last_prediction_date: null,
        }] })
        .mockResolvedValueOnce({ rows: [{
          address: ADDRESS, current_streak: 0, best_streak: 0,
          total_predictions: 0, last_prediction_date: null,
        }] });

      const streak = await Engagement.getOrInitStreak(ADDRESS);
      expect(streak.current_streak).toBe(0);
      expect(streak.best_streak).toBe(0);
      expect(streak.total_predictions).toBe(0);
    });
  });

  describe('recordPrediction', () => {
    it('advances the streak when predicting on consecutive days', async () => {
      // getOrInitStreak: insert returns a row with a previous streak
      mockPool
        .mockResolvedValueOnce({ rows: [{
          address: ADDRESS, current_streak: 2, best_streak: 2,
          total_predictions: 5, last_prediction_date: new Date().toISOString(),
        }] })
        // evaluateAchievements: achievements query returns a badge catalog
        .mockResolvedValueOnce({ rows: [{
          id: 1, code: 'first_prediction', category: 'general', threshold: 1,
        }] })
        // check if already earned (before query)
        .mockResolvedValueOnce({ rows: [] })
        // awardAchievement insert
        .mockResolvedValueOnce({ rows: [] })
        // createNotification insert
        .mockResolvedValueOnce({ rows: [] })
        // second getOrInit... no more
        .mockResolvedValue({ rows: [] });

      const { streak, earnedAchievements } = await Engagement.recordPrediction(ADDRESS);

      expect(streak.current_streak).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(earnedAchievements)).toBe(true);
    });

    it('resets the streak after a missed day', async () => {
      const lastDate = new Date();
      lastDate.setUTCDate(lastDate.getUTCDate() - 5);

      mockPool
        .mockResolvedValueOnce({ rows: [{
          address: ADDRESS, current_streak: 3, best_streak: 5,
          total_predictions: 8, last_prediction_date: lastDate.toISOString(),
        }] })
        .mockResolvedValue({ rows: [] });

      const { streak } = await Engagement.recordPrediction(ADDRESS);
      expect(streak.current_streak).toBe(1);
    });
  });

  describe('registerReferral', () => {
    it('creates a referral when the referred address is not linked', async () => {
      mockPool
        .mockResolvedValueOnce({ rows: [] }) // existing check
        .mockResolvedValueOnce({ rows: [{
          id: 1, referrer_address: ADDRESS, referred_address: 'GOTHER...', referral_code: 'CODE1',
        }] }) // insert
        .mockResolvedValue({ rows: [] }); // achievements

      const referral = await Engagement.registerReferral(ADDRESS, 'GOTHER...', 'CODE1');
      expect(referral).not.toBeNull();
    });

    it('returns null when the referred address is already linked', async () => {
      mockPool.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const referral = await Engagement.registerReferral(ADDRESS, 'GOTHER...', 'CODE1');
      expect(referral).toBeNull();
    });

    it('rejects referring yourself', async () => {
      await expect(
        Engagement.registerReferral(ADDRESS, ADDRESS, 'CODE1'),
      ).rejects.toThrow();
    });
  });

  describe('calculateReferralPayout', () => {
    it('computes payout breakdown across tree levels', async () => {
      // buildReferralTree: fetch all referrals
      mockPool.mockResolvedValueOnce({ rows: [
        { referrer_address: ADDRESS, referred_address: 'GDIRECT1' },
        { referrer_address: 'GDIRECT1', referred_address: 'GLEVEL2' },
      ] });

      const result = await Engagement.calculateReferralPayout(ADDRESS, '100');

      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0].level).toBe(1);
      expect(result.breakdown[0].count).toBe(1);
      expect(Number(result.totalPayout)).toBeGreaterThan(0);
    });
  });

  describe('getLeaderboard', () => {
    it('returns ranked entries from the streaks table', async () => {
      mockPool.mockResolvedValueOnce({ rows: [
        { address: ADDRESS, total_predictions: 10, score: 20 },
        { address: 'GSECOND', total_predictions: 5, score: 10 },
      ] });

      const { entries } = await Engagement.getLeaderboard(50);
      expect(entries).toHaveLength(2);
      expect(entries[0].rank).toBe(1);
      expect(entries[0].address).toBe(ADDRESS);
    });
  });

  describe('publishLeaderboardRank', () => {
    it('publishes a leaderboard_rank event to the feed', async () => {
      mockPool.mockResolvedValueOnce({ rows: [
        { address: ADDRESS, total_predictions: 10, score: 20 },
      ] });

      await Engagement.publishLeaderboardRank(ADDRESS);
      expect(mockFeedPublish).toHaveBeenCalled();
      const event = mockFeedPublish.mock.calls[0][0];
      expect(event.type).toBe('leaderboard_rank');
      expect(event.address).toBe(ADDRESS);
    });

    it('does not throw when the feed is not initialised', async () => {
      mockPool.mockResolvedValueOnce({ rows: [] });
      (getActivityFeed as unknown as jest.Mock).mockImplementationOnce(() => {
        throw new Error('ActivityFeed not initialised');
      });

      await expect(Engagement.publishLeaderboardRank(ADDRESS)).resolves.toBeUndefined();
    });
  });
});
