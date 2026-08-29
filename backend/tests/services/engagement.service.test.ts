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
  });
});
