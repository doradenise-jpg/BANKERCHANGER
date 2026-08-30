// tests/services/engagement.service.test.ts
// Unit coverage for streaks, achievement badges, the referral tree,
// multi-level referral payouts, and leaderboard rank updates.

import { engagementService } from '../../src/services/engagement.service';
import { AppError } from '../../src/utils/AppError';

beforeEach(() => {
  engagementService.__reset();
});

describe('prediction streaks', () => {
  it('increments the current streak on wins and tracks the longest', () => {
    engagementService.recordPredictionResult('u1', true);
    engagementService.recordPredictionResult('u1', true);
    const { streak } = engagementService.recordPredictionResult('u1', true);

    expect(streak.current).toBe(3);
    expect(streak.longest).toBe(3);
    expect(streak.totalWins).toBe(3);
    expect(streak.totalSettled).toBe(3);
  });

  it('resets the current streak on a loss but keeps the longest', () => {
    engagementService.recordPredictionResult('u1', true);
    engagementService.recordPredictionResult('u1', true);
    engagementService.recordPredictionResult('u1', false);

    const streak = engagementService.getStreak('u1');
    expect(streak.current).toBe(0);
    expect(streak.longest).toBe(2);
    expect(streak.totalSettled).toBe(3);
  });
});

describe('achievement badges', () => {
  it('awards first_win and streak badges as thresholds are crossed', () => {
    const first = engagementService.recordPredictionResult('u1', true);
    expect(first.newBadges.map((b) => b.code)).toContain('first_win');

    engagementService.recordPredictionResult('u1', true);
    const third = engagementService.recordPredictionResult('u1', true);
    expect(third.newBadges.map((b) => b.code)).toContain('streak_3');

    const codes = engagementService.getBadges('u1').map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(['first_win', 'streak_3']));
  });

  it('never awards the same badge twice', () => {
    let streak3Awards = 0;
    for (let i = 0; i < 6; i++) {
      const res = engagementService.recordPredictionResult('u1', true);
      streak3Awards += res.newBadges.filter((b) => b.code === 'streak_3').length;
    }
    expect(streak3Awards).toBe(1);
    expect(engagementService.getBadges('u1').filter((b) => b.code === 'streak_3')).toHaveLength(1);
  });

  it('awards sharpshooter at 25 lifetime wins', () => {
    let sawSharpshooter = false;
    for (let i = 0; i < 25; i++) {
      const res = engagementService.recordPredictionResult('u1', true);
      if (res.newBadges.some((b) => b.code === 'sharpshooter')) sawSharpshooter = true;
    }
    expect(sawSharpshooter).toBe(true);
  });
});

describe('referral tree', () => {
  it('links referees under a referrer and builds a multi-level tree', () => {
    engagementService.registerReferral('root', 'a');
    engagementService.registerReferral('root', 'b');
    engagementService.registerReferral('a', 'a1');
    engagementService.registerReferral('a1', 'a1x');

    const tree = engagementService.getReferralTree('root');
    expect(tree.userId).toBe('root');
    expect(tree.children.map((c) => c.userId).sort()).toEqual(['a', 'b']);

    const a = tree.children.find((c) => c.userId === 'a')!;
    expect(a.depth).toBe(1);
    expect(a.children[0].userId).toBe('a1');
    // Depth is capped at 3 levels: a1x sits at depth 3 and has no children rendered.
    expect(a.children[0].children[0].userId).toBe('a1x');
    expect(a.children[0].children[0].children).toHaveLength(0);
  });

  it('rejects self-referral, double-referral, and cycles', () => {
    expect(() => engagementService.registerReferral('x', 'x')).toThrow(AppError);

    engagementService.registerReferral('p', 'c');
    expect(() => engagementService.registerReferral('q', 'c')).toThrow(/already been referred/);

    engagementService.registerReferral('c', 'g');
    expect(() => engagementService.registerReferral('g', 'p')).toThrow(/cycle/);
  });

  it('is idempotent when the same edge is registered twice', () => {
    engagementService.registerReferral('p', 'c');
    engagementService.registerReferral('p', 'c');
    expect(engagementService.getDirectReferrals('p')).toEqual(['c']);
  });

  it('awards referral badges', () => {
    for (let i = 0; i < 5; i++) engagementService.registerReferral('r', `ref${i}`);
    const codes = engagementService.getBadges('r').map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(['referral_starter', 'referral_captain']));
  });
});

describe('referral payouts', () => {
  beforeEach(() => {
    // root -> l1 -> l2 -> l3
    engagementService.registerReferral('root', 'l1');
    engagementService.registerReferral('l1', 'l2');
    engagementService.registerReferral('l2', 'l3');
  });

  it('credits commission up to three ancestor levels on a recorded fee', () => {
    const payouts = engagementService.recordReferralFee('l3', 1000);

    expect(payouts).toEqual([
      { level: 1, fromUserId: 'l3', amount: 100 }, // l2 gets 10%
      { level: 2, fromUserId: 'l3', amount: 50 }, // l1 gets 5%
      { level: 3, fromUserId: 'l3', amount: 25 }, // root gets 2.5%
    ]);

    expect(engagementService.getReferralEarnings('l2')).toBe(100);
    expect(engagementService.getReferralEarnings('l1')).toBe(50);
    expect(engagementService.getReferralEarnings('root')).toBe(25);
  });

  it('computeReferralPayouts reflects accumulated downline fees without mutating', () => {
    engagementService.recordReferralFee('l1', 200); // root: 10% => 20
    engagementService.recordReferralFee('l2', 400); // root: 5% => 20, l1: 10% => 40

    const rootPayouts = engagementService.computeReferralPayouts('root');
    const total = rootPayouts.reduce((sum, p) => sum + p.amount, 0);
    expect(total).toBeCloseTo(40); // 20 (from l1) + 20 (from l2)

    // Calling compute again yields the same result (pure).
    const again = engagementService.computeReferralPayouts('root');
    expect(again).toEqual(rootPayouts);
  });

  it('rejects non-positive fees', () => {
    expect(() => engagementService.recordReferralFee('l3', 0)).toThrow(AppError);
    expect(() => engagementService.recordReferralFee('l3', -5)).toThrow(AppError);
  });
});

describe('leaderboard & rank updates', () => {
  it('ranks users by points and reports rank changes', () => {
    const seen: number[] = [];
    engagementService.setRankUpdateListener((updates) => seen.push(updates.length));

    engagementService.addPoints('alice', 100);
    engagementService.addPoints('bob', 50);
    const overtake = engagementService.addPoints('bob', 100); // bob -> 150, now #1

    expect(engagementService.getLeaderboard().map((e) => e.userId)).toEqual(['bob', 'alice']);
    expect(engagementService.getRank('bob')).toBe(1);
    expect(engagementService.getRank('alice')).toBe(2);

    const bobUpdate = overtake.find((u) => u.userId === 'bob')!;
    expect(bobUpdate.previousRank).toBe(2);
    expect(bobUpdate.newRank).toBe(1);
    expect(bobUpdate.direction).toBe('up');
    expect(seen.length).toBeGreaterThan(0);
  });

  it('awards the top_10 badge when a user enters the top 10', () => {
    engagementService.addPoints('star', 500);
    expect(engagementService.getBadges('star').map((b) => b.code)).toContain('top_10');
  });

  it('respects the leaderboard limit', () => {
    for (let i = 0; i < 5; i++) engagementService.addPoints(`u${i}`, (i + 1) * 10);
    expect(engagementService.getLeaderboard(3)).toHaveLength(3);
  });

  it('rejects non-positive point additions', () => {
    expect(() => engagementService.addPoints('u1', 0)).toThrow(AppError);
  });

  it('does not let a throwing listener break state', () => {
    engagementService.setRankUpdateListener(() => {
      throw new Error('boom');
    });
    expect(() => engagementService.addPoints('u1', 10)).not.toThrow();
    expect(engagementService.getRank('u1')).toBe(1);

import http from 'http';
import { ActivityFeed } from '../../src/websocket/realtime';
import { EngagementService } from '../../src/services/engagement.service';

describe('EngagementService', () => {
  it('tracks streaks and grants badges for consecutive correct predictions', async () => {
    const service = new EngagementService();

    service.recordPredictionResult('user-1', true);
    service.recordPredictionResult('user-1', true);
    service.recordPredictionResult('user-1', false);
    service.recordPredictionResult('user-1', true);
    service.recordPredictionResult('user-1', true);
    service.recordPredictionResult('user-1', true);

    const stats = service.getUserStats('user-1');
    const badges = service.getUserBadges('user-1');

    expect(stats.currentStreak).toBe(3);
    expect(stats.longestStreak).toBe(3);
    expect(stats.totalWins).toBe(5);
    expect(badges.some((b) => b.code === 'streak_3')).toBe(true);
    expect(badges.some((b) => b.code === 'predictor')).toBe(true);
  });

  it('tracks referral tree depth and computes payouts', async () => {
    const service = new EngagementService();

    service.trackReferral('referrer-1', 'user-2');
    service.trackReferral('referrer-1', 'user-3');
    service.trackReferral('user-2', 'user-4');
    service.trackReferral('user-3', 'user-5');
    service.trackReferral('user-5', 'user-6');

    const tree = service.getReferralTree('referrer-1');
    const payout = service.calculateReferralPayout('referrer-1');

    expect(tree.depth).toBe(3);
    expect(tree.totalReferrals).toBe(5);
    expect(payout.total).toBe(0.32);
    expect(payout.breakdown[0].amount).toBe(0.2);
  });

  it('tracks deeper referral chains without truncating depth', async () => {
    const service = new EngagementService();

    service.trackReferral('root-user', 'level-1-a');
    service.trackReferral('root-user', 'level-1-b');
    service.trackReferral('level-1-a', 'level-2-a');
    service.trackReferral('level-2-a', 'level-3-a');

    const tree = service.getReferralTree('root-user');
    const payout = service.calculateReferralPayout('root-user');

    expect(tree.depth).toBe(3);
    expect(tree.totalReferrals).toBe(4);
    expect(payout.total).toBe(0.27);
    expect(payout.breakdown.map((entry) => entry.level)).toEqual([1, 2, 3]);
  });

  it('publishes leaderboard rank updates over WebSocket', async () => {
    const server = http.createServer();
    const feed = new ActivityFeed(server);

    await new Promise<void>((resolve) => server.listen(0, resolve));

    try {
      const ws = new (require('ws'))( `ws://localhost:${(server.address() as any).port}` );
      await new Promise<void>((resolve) => ws.once('open', resolve));

      ws.send(JSON.stringify({ type: 'auth', token: require('jsonwebtoken').sign({ sub: 'user-1', type: 'access' }, process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me') }));
      await new Promise((resolve) => setImmediate(resolve));
      ws.send(JSON.stringify({ type: 'subscribe_leaderboard', leaderboardId: 'global' }));
      await new Promise((resolve) => setImmediate(resolve));

      const service = new EngagementService(feed);
      service.publishLeaderboardUpdate({ userId: 'user-1', rank: 7, leaderboardId: 'global', score: 980, displayName: 'Player One' });

      const payload = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for leaderboard update')), 500);
        ws.once('message', (data) => {
          clearTimeout(timer);
          resolve(data.toString());
        });
      });

      const event = JSON.parse(payload);
      expect(event.type).toBe('leaderboard_rank_update');
      expect(event.userId).toBe('user-1');
      expect(event.rank).toBe(7);

      ws.close();
    } finally {
      feed.close();
      server.close();
    }

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
