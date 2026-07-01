import cron from 'node-cron';
import { logger } from '../utils/logger';
import {
  deleteExpiredSessions,
  deleteExpiredResetTokens,
  softDeleteOldNotifications,
  archiveFailedDistributions,
} from '../services/cron.service';
import { withDistributedLock } from '../utils/distributedLock';

export function startCleanupCron(): void {
  if (process.env.CLEANUP_CRON_DISABLED === 'true') {
    logger.info('Cleanup cron jobs disabled via CLEANUP_CRON_DISABLED');
    return;
  }

  // Hourly — expired sessions
  // Lock TTL: 90 minutes (longer than cron interval)
  const cleanupSessionsWithLock = withDistributedLock('cleanupSessions', 90 * 60, async () => {
    const count = await deleteExpiredSessions();
    logger.info({ count }, 'cleanupSessions: completed');
  });

  cron.schedule('0 * * * *', cleanupSessionsWithLock);

  // Hourly — expired password-reset tokens
  // Lock TTL: 90 minutes (longer than cron interval)
  const cleanupResetTokensWithLock = withDistributedLock('cleanupResetTokens', 90 * 60, async () => {
    const count = await deleteExpiredResetTokens();
    logger.info({ count }, 'cleanupResetTokens: completed');
  });

  cron.schedule('0 * * * *', cleanupResetTokensWithLock);

  // Daily at 02:00 — soft-delete old notifications
  // Lock TTL: 2 hours (longer than daily interval margin)
  const cleanupNotificationsWithLock = withDistributedLock('cleanupNotifications', 2 * 60 * 60, async () => {
    const count = await softDeleteOldNotifications();
    logger.info({ count }, 'cleanupNotifications: completed');
  });

  cron.schedule('0 2 * * *', cleanupNotificationsWithLock);

  // Weekly on Sunday at 03:00 — archive failed distributions
  // Lock TTL: 3 hours (longer than weekly interval margin)
  const cleanupDistributionsWithLock = withDistributedLock('cleanupDistributions', 3 * 60 * 60, async () => {
    const count = await archiveFailedDistributions();
    logger.info({ count }, 'cleanupDistributions: completed');
  });

  cron.schedule('0 3 * * 0', cleanupDistributionsWithLock);

  logger.info('Cleanup cron jobs scheduled (sessions/tokens: hourly, notifications: daily, distributions: weekly)');
}
