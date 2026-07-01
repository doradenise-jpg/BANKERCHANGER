import {
  setDbAdapter,
  deleteExpiredSessions,
  deleteExpiredResetTokens,
  softDeleteOldNotifications,
  archiveFailedDistributions,
  type CronDbAdapter,
} from '../../src/services/cron.service';

// ── Mock metrics so tests never register real Prometheus counters ─────────────
jest.mock('../../src/services/metrics.service', () => ({
  cronSessionsDeleted: { inc: jest.fn() },
  cronResetTokensDeleted: { inc: jest.fn() },
  cronNotificationsSoftDeleted: { inc: jest.fn() },
  cronDistributionsArchived: { inc: jest.fn() },
}));

import {
  cronSessionsDeleted,
  cronResetTokensDeleted,
  cronNotificationsSoftDeleted,
  cronDistributionsArchived,
} from '../../src/services/metrics.service';

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeAdapter(overrides: Partial<CronDbAdapter> = {}): CronDbAdapter {
  return {
    deleteExpiredSessions: jest.fn().mockResolvedValue(0),
    deleteExpiredResetTokens: jest.fn().mockResolvedValue(0),
    softDeleteOldNotifications: jest.fn().mockResolvedValue(0),
    archiveFailedDistributions: jest.fn().mockResolvedValue(0),
    writeAuditLog: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('cron.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1 ─────────────────────────────────────────────────────────────────────────
  describe('deleteExpiredSessions', () => {
    it('calls adapter.deleteExpiredSessions and returns row count', async () => {
      const adapter = makeAdapter({
        deleteExpiredSessions: jest.fn().mockResolvedValue(7),
      });
      setDbAdapter(adapter);

      const result = await deleteExpiredSessions();

      expect(adapter.deleteExpiredSessions).toHaveBeenCalledTimes(1);
      expect(result).toBe(7);
    });

    it('increments Prometheus counter by the number of deleted rows', async () => {
      setDbAdapter(makeAdapter({ deleteExpiredSessions: jest.fn().mockResolvedValue(3) }));

      await deleteExpiredSessions();

      expect((cronSessionsDeleted.inc as jest.Mock)).toHaveBeenCalledWith(3);
    });

    it('increments counter with 0 when no rows are deleted', async () => {
      setDbAdapter(makeAdapter({ deleteExpiredSessions: jest.fn().mockResolvedValue(0) }));

      await deleteExpiredSessions();

      expect((cronSessionsDeleted.inc as jest.Mock)).toHaveBeenCalledWith(0);
    });
  });

  // 2 ─────────────────────────────────────────────────────────────────────────
  describe('deleteExpiredResetTokens', () => {
    it('calls adapter.deleteExpiredResetTokens and returns row count', async () => {
      const adapter = makeAdapter({
        deleteExpiredResetTokens: jest.fn().mockResolvedValue(4),
      });
      setDbAdapter(adapter);

      const result = await deleteExpiredResetTokens();

      expect(adapter.deleteExpiredResetTokens).toHaveBeenCalledTimes(1);
      expect(result).toBe(4);
    });

    it('increments Prometheus counter by the number of deleted rows', async () => {
      setDbAdapter(makeAdapter({ deleteExpiredResetTokens: jest.fn().mockResolvedValue(2) }));

      await deleteExpiredResetTokens();

      expect((cronResetTokensDeleted.inc as jest.Mock)).toHaveBeenCalledWith(2);
    });
  });

  // 3 ─────────────────────────────────────────────────────────────────────────
  describe('softDeleteOldNotifications', () => {
    it('calls adapter.softDeleteOldNotifications and returns row count', async () => {
      const adapter = makeAdapter({
        softDeleteOldNotifications: jest.fn().mockResolvedValue(15),
      });
      setDbAdapter(adapter);

      const result = await softDeleteOldNotifications();

      expect(adapter.softDeleteOldNotifications).toHaveBeenCalledTimes(1);
      expect(result).toBe(15);
    });

    it('increments Prometheus counter by the number of soft-deleted rows', async () => {
      setDbAdapter(makeAdapter({ softDeleteOldNotifications: jest.fn().mockResolvedValue(10) }));

      await softDeleteOldNotifications();

      expect((cronNotificationsSoftDeleted.inc as jest.Mock)).toHaveBeenCalledWith(10);
    });

    it('does not call other adapters', async () => {
      const adapter = makeAdapter({
        softDeleteOldNotifications: jest.fn().mockResolvedValue(5),
      });
      setDbAdapter(adapter);

      await softDeleteOldNotifications();

      expect(adapter.deleteExpiredSessions).not.toHaveBeenCalled();
      expect(adapter.deleteExpiredResetTokens).not.toHaveBeenCalled();
      expect(adapter.archiveFailedDistributions).not.toHaveBeenCalled();
    });
  });

  // 4 ─────────────────────────────────────────────────────────────────────────
  describe('archiveFailedDistributions', () => {
    it('calls adapter.archiveFailedDistributions and returns row count', async () => {
      const adapter = makeAdapter({
        archiveFailedDistributions: jest.fn().mockResolvedValue(9),
      });
      setDbAdapter(adapter);

      const result = await archiveFailedDistributions();

      expect(adapter.archiveFailedDistributions).toHaveBeenCalledTimes(1);
      expect(result).toBe(9);
    });

    it('increments Prometheus counter by the number of archived rows', async () => {
      setDbAdapter(makeAdapter({ archiveFailedDistributions: jest.fn().mockResolvedValue(6) }));

      await archiveFailedDistributions();

      expect((cronDistributionsArchived.inc as jest.Mock)).toHaveBeenCalledWith(6);
    });
  });

  // 5 — cross-cutting: jobs are independent ───────────────────────────────────
  describe('job isolation', () => {
    it('each job calls only its own adapter method', async () => {
      const adapter = makeAdapter({
        deleteExpiredSessions: jest.fn().mockResolvedValue(1),
        deleteExpiredResetTokens: jest.fn().mockResolvedValue(1),
        softDeleteOldNotifications: jest.fn().mockResolvedValue(1),
        archiveFailedDistributions: jest.fn().mockResolvedValue(1),
      });
      setDbAdapter(adapter);

      await deleteExpiredSessions();
      expect(adapter.deleteExpiredSessions).toHaveBeenCalledTimes(1);
      expect(adapter.deleteExpiredResetTokens).not.toHaveBeenCalled();
      expect(adapter.softDeleteOldNotifications).not.toHaveBeenCalled();
      expect(adapter.archiveFailedDistributions).not.toHaveBeenCalled();
    });
  });

  // 6 — audit log: session_cleanup entries are written ─────────────────────────
  describe('audit log (admin_audit_log)', () => {
    it('writes an audit entry with action=session_cleanup after deleteExpiredSessions', async () => {
      const adapter = makeAdapter({
        deleteExpiredSessions: jest.fn().mockResolvedValue(5),
      });
      setDbAdapter(adapter);

      await deleteExpiredSessions();

      expect(adapter.writeAuditLog).toHaveBeenCalledTimes(1);
      expect(adapter.writeAuditLog).toHaveBeenCalledWith(
        'session_cleanup',
        expect.objectContaining({ deleted_sessions: 5 }),
      );
    });

    it('writes an audit entry with action=session_cleanup after deleteExpiredResetTokens', async () => {
      const adapter = makeAdapter({
        deleteExpiredResetTokens: jest.fn().mockResolvedValue(3),
      });
      setDbAdapter(adapter);

      await deleteExpiredResetTokens();

      expect(adapter.writeAuditLog).toHaveBeenCalledTimes(1);
      expect(adapter.writeAuditLog).toHaveBeenCalledWith(
        'session_cleanup',
        expect.objectContaining({ deleted_reset_tokens: 3 }),
      );
    });

    it('includes run_at timestamp in audit entry', async () => {
      const adapter = makeAdapter({
        deleteExpiredSessions: jest.fn().mockResolvedValue(0),
      });
      setDbAdapter(adapter);

      await deleteExpiredSessions();

      const [, details] = (adapter.writeAuditLog as jest.Mock).mock.calls[0];
      expect(details).toHaveProperty('run_at');
      expect(typeof details.run_at).toBe('string');
    });

    it('does NOT write audit log for softDeleteOldNotifications', async () => {
      const adapter = makeAdapter({
        softDeleteOldNotifications: jest.fn().mockResolvedValue(10),
      });
      setDbAdapter(adapter);

      await softDeleteOldNotifications();

      expect(adapter.writeAuditLog).not.toHaveBeenCalled();
    });

    it('does NOT write audit log for archiveFailedDistributions', async () => {
      const adapter = makeAdapter({
        archiveFailedDistributions: jest.fn().mockResolvedValue(2),
      });
      setDbAdapter(adapter);

      await archiveFailedDistributions();

      expect(adapter.writeAuditLog).not.toHaveBeenCalled();
    });
  });
});
