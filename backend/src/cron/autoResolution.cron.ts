import cron from 'node-cron';
import { logger } from '../utils/logger';
import { runAutoResolutionJob, runAutoLockMarketsJob } from '../oracle/OracleService';
import { withDistributedLock } from '../utils/distributedLock';

export function startAutoResolutionCron(): void {
  if (process.env.AUTO_RESOLUTION_CRON_DISABLED === 'true') {
    logger.info('Auto-resolution cron job is disabled via AUTO_RESOLUTION_CRON_DISABLED');
    return;
  }

  // Every 10 minutes
  // Lock TTL: 15 minutes (longer than cron interval to prevent overlap)
  const jobWithLock = withDistributedLock('autoResolution', 15 * 60, async () => {
    logger.info('autoResolutionJob: starting');
    try {
      await runAutoResolutionJob();
      logger.info('autoResolutionJob: completed');
    } catch (err) {
      logger.error({ err }, 'autoResolutionJob: failed');
      throw err;
    }
  });

  cron.schedule('*/10 * * * *', jobWithLock);

  logger.info('Auto-resolution cron job scheduled (every 10 minutes)');
}

export function startAutoLockCron(): void {
  if (process.env.AUTO_LOCK_CRON_DISABLED === 'true') {
    logger.info('Auto-lock cron job is disabled via AUTO_LOCK_CRON_DISABLED');
    return;
  }

  // Every 60 seconds — lock markets whose lock threshold has passed
  // Lock TTL: 2 minutes (longer than cron interval to prevent overlap)
  const jobWithLock = withDistributedLock('autoLock', 2 * 60, async () => {
    logger.debug('autoLockJob: starting');
    try {
      const { locked, failed } = await runAutoLockMarketsJob();
      if (locked > 0 || failed > 0) {
        logger.info({ locked, failed }, 'autoLockJob: completed');
      }
    } catch (err) {
      logger.error({ err }, 'autoLockJob: failed');
      throw err;
    }
  });

  cron.schedule('* * * * *', jobWithLock);

  logger.info('Auto-lock cron job scheduled (every 60 seconds)');
}
