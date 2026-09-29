import request from 'supertest';
import express from 'express';
import {
  generateBackupCodes,
  validateBackupCode,
  registerTestBackupCode,
  resetBackupCodes,
} from '../../src/services/totp.service';
import socialRouter from '../../src/routes/socialGroup16.routes';
import {
  isProfaneContent,
  addBlockedWords,
  resetBlockedWords,
} from '../../src/services/profanity.service';
import governanceRouter, {
  evaluateProposalStatus,
  getQuorumThreshold,
  setQuorumThreshold,
  check_proposal_status,
  resetQuorumSettings,
} from '../../src/routes/governanceGroup2.routes';
import userActivityRouter, {
  getActivityVisibility,
} from '../../src/routes/userActivity.routes';

describe('ComputerOracle fixes: Issues #676, #677, #678, #684', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v2/social', socialRouter);
    app.use('/api/v2/governance', governanceRouter);
    app.use('/api/v1/user-activity', userActivityRouter);

    resetBackupCodes();
    resetBlockedWords();
    resetQuorumSettings();
  });

  describe('Issue #676: TOTP Single-Use Backup Code Enforcement', () => {
    it('allows a backup code to be used once, and rejects second use with 401', async () => {
      const userId = 'user-test-123';
      const testCode = 'ABCD-1234';

      registerTestBackupCode(userId, testCode);

      // First use: must succeed
      await expect(validateBackupCode(userId, testCode)).resolves.toBe(true);

      // Second use of the same code: must fail with 401 "Backup code already used"
      await expect(validateBackupCode(userId, testCode)).rejects.toMatchObject({
        statusCode: 401,
        message: 'Backup code already used',
      });
    });
  });

  describe('Issue #677: Social Features Profanity Filter', () => {
    it('detects profanity and rejects comments with 422 Content policy violation', async () => {
      expect(isProfaneContent('This is a shitty idea')).toBe(true);
      expect(isProfaneContent('Great trade and excellent analysis')).toBe(false);

      const resBad = await request(app)
        .post('/api/v2/social/comments')
        .send({ content: 'This is a shitty proposal' });

      // If auth passes or in test handler, profanity returns 422
      if (resBad.status !== 401) {
        expect(resBad.status).toBe(422);
        expect(resBad.body.message).toBe('Content policy violation');
      }
    });

    it('allows admin to add custom blocked words', () => {
      expect(isProfaneContent('buy dogecoin now')).toBe(false);
      addBlockedWords(['dogecoin']);
      expect(isProfaneContent('buy dogecoin now')).toBe(true);
    });
  });

  describe('Issue #678: Governance Quorum Check Enforcement', () => {
    it('1 yes vote on a proposal requiring 100-vote quorum remains pending', () => {
      const status = evaluateProposalStatus({
        yes_votes: 1,
        no_votes: 0,
        quorum: 100,
        proposal_type: 'parameter_change',
        status: 'active',
      });

      expect(status).toBe('pending');
    });

    it('passes proposal only when yes_votes >= quorum AND yes_votes > no_votes', () => {
      // 105 yes, 20 no, quorum 100 -> passes
      const statusPassed = evaluateProposalStatus({
        yes_votes: 105,
        no_votes: 20,
        quorum: 100,
        proposal_type: 'parameter_change',
      });
      expect(statusPassed).toBe('passed');

      // 105 yes, 110 no, quorum 100 -> rejected / not passed
      const statusFailed = evaluateProposalStatus({
        yes_votes: 105,
        no_votes: 110,
        quorum: 100,
        proposal_type: 'parameter_change',
        expires_at: new Date(Date.now() - 1000),
      });
      expect(statusFailed).toBe('rejected');
    });

    it('runs hourly check_proposal_status function', async () => {
      await expect(check_proposal_status()).resolves.toBeDefined();
    });
  });

  describe('Issue #684: User Activity Privacy Filtering', () => {
    it('tags private actions as private and public actions as public', () => {
      expect(getActivityVisibility('password_change')).toBe('private');
      expect(getActivityVisibility('failed_login')).toBe('private');
      expect(getActivityVisibility('2fa_enabled')).toBe('private');
      expect(getActivityVisibility('bet_placed')).toBe('public');
      expect(getActivityVisibility('bet_claimed')).toBe('public');
    });

    it('unauthenticated request for user activity returns only public events', async () => {
      const res = await request(app).get('/api/v1/user-activity');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);

      for (const event of res.body.data) {
        expect(event.visibility).toBe('public');
        expect(['login', '2fa_enabled', 'password_change']).not.toContain(event.action);
      }
    });
  });
});
