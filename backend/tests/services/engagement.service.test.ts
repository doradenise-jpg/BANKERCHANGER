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
  });
});
