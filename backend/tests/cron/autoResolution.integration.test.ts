import cron from 'node-cron';
import { startAutoResolutionCron, startAutoLockCron } from '../../src/cron/autoResolution.cron';
import { runAutoResolutionJob, runAutoLockMarketsJob } from '../../src/oracle/OracleService';

// ── Mock logger ────────────────────────────────────────────────────────────────
jest.mock('../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

import { logger } from '../../src/utils/logger';

// ── Mock OracleService ─────────────────────────────────────────────────────────
jest.mock('../../src/oracle/OracleService', () => ({
  runAutoResolutionJob: jest.fn().mockResolvedValue({
    processed: 0,
    resolved: 0,
    failed: 0,
  }),
  runAutoLockMarketsJob: jest.fn().mockResolvedValue({
    locked: 0,
    failed: 0,
  }),
}));

// ── Mock cron module to control scheduling ─────────────────────────────────────
// We'll replace the real cron.schedule with a controllable version
const realCron = jest.requireActual('node-cron');
const mockScheduledTasks: Map<string, NodeJS.Timer | null> = new Map();

jest.mock('node-cron', () => ({
  schedule: jest.fn((pattern: string, callback: () => void) => {
    // Store the callback so we can invoke it manually in tests
    const taskId = `task-${pattern}-${Date.now()}`;
    mockScheduledTasks.set(taskId, null);
    
    return {
      start: jest.fn(),
      stop: jest.fn(),
      destroy: jest.fn(),
      _callback: callback,
      _pattern: pattern,
    };
  }),
}));

describe('autoResolution.cron - integration tests', () => {
  let mockCronSchedule: jest.MockedFunction<typeof cron.schedule>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduledTasks.clear();
    mockCronSchedule = cron.schedule as jest.MockedFunction<typeof cron.schedule>;
    
    // Clear env vars for each test
    delete process.env.AUTO_RESOLUTION_CRON_DISABLED;
    delete process.env.AUTO_LOCK_CRON_DISABLED;
  });

  describe('startAutoResolutionCron', () => {
    it('should schedule cron job with 10-minute interval', () => {
      startAutoResolutionCron();

      expect(mockCronSchedule).toHaveBeenCalledTimes(1);
      const [pattern] = mockCronSchedule.mock.calls[0];
      expect(pattern).toBe('*/10 * * * *'); // Every 10 minutes
    });

    it('should call runAutoResolutionJob when cron fires', async () => {
      startAutoResolutionCron();

      // Extract and invoke the callback
      const [, callback] = mockCronSchedule.mock.calls[0];
      await callback();

      expect(runAutoResolutionJob).toHaveBeenCalledTimes(1);
    });

    it('should log success when job completes', async () => {
      (runAutoResolutionJob as jest.Mock).mockResolvedValue({
        processed: 5,
        resolved: 3,
        failed: 0,
      });

      startAutoResolutionCron();

      const [, callback] = mockCronSchedule.mock.calls[0];
      await callback();

      expect((logger.info as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ processed: 5, resolved: 3, failed: 0 }),
        expect.stringContaining('autoResolutionJob: completed'),
      );
    });

    it('should log error and continue if runAutoResolutionJob throws', async () => {
      const testError = new Error('RPC connection failed');
      (runAutoResolutionJob as jest.Mock).mockRejectedValue(testError);

      startAutoResolutionCron();

      const [, callback] = mockCronSchedule.mock.calls[0];
      await callback();

      expect((logger.error as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ err: testError }),
        expect.stringContaining('autoResolutionJob: fatal error'),
      );
    });

    it('should skip execution if previous run is still in progress', async () => {
      // Mock the job to hang (never resolve)
      let resolveFirstRun: (() => void) | null = null;
      (runAutoResolutionJob as jest.Mock).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFirstRun = resolve;
          }),
      );

      startAutoResolutionCron();
      const [, callback] = mockCronSchedule.mock.calls[0];

      // Start first run (will hang)
      const firstRunPromise = callback();

      // Immediately fire cron again before first run completes
      callback();

      // Verify skip was logged
      expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('autoResolutionJob: previous run still in progress'),
      );

      // runAutoResolutionJob should only be called once
      expect(runAutoResolutionJob).toHaveBeenCalledTimes(1);

      // Clean up: resolve the first run
      if (resolveFirstRun) resolveFirstRun();
      await firstRunPromise;
    });

    it('should be disabled when AUTO_RESOLUTION_CRON_DISABLED is true', () => {
      process.env.AUTO_RESOLUTION_CRON_DISABLED = 'true';

      startAutoResolutionCron();

      expect(mockCronSchedule).not.toHaveBeenCalled();
      expect((logger.info as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('Auto-resolution cron job is disabled'),
      );
    });

    it('should reset running flag even if job throws', async () => {
      (runAutoResolutionJob as jest.Mock).mockRejectedValue(new Error('DB error'));

      startAutoResolutionCron();
      const [, callback] = mockCronSchedule.mock.calls[0];

      // First call throws
      await callback();

      // Second call should execute (flag was reset in finally block)
      (runAutoResolutionJob as jest.Mock).mockClear();
      (runAutoResolutionJob as jest.Mock).mockResolvedValue({ processed: 0, resolved: 0, failed: 0 });

      await callback();

      expect(runAutoResolutionJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('startAutoLockCron', () => {
    it('should schedule cron job with 60-second interval', () => {
      startAutoLockCron();

      expect(mockCronSchedule).toHaveBeenCalledTimes(1);
      const [pattern] = mockCronSchedule.mock.calls[0];
      expect(pattern).toBe('* * * * *'); // Every minute
    });

    it('should call runAutoLockMarketsJob when cron fires', async () => {
      startAutoLockCron();

      const [, callback] = mockCronSchedule.mock.calls[0];
      await callback();

      expect(runAutoLockMarketsJob).toHaveBeenCalledTimes(1);
    });

    it('should log stats when markets are locked', async () => {
      (runAutoLockMarketsJob as jest.Mock).mockResolvedValue({
        locked: 7,
        failed: 2,
      });

      startAutoLockCron();

      const [, callback] = mockCronSchedule.mock.calls[0];
      await callback();

      expect((logger.info as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ locked: 7, failed: 2 }),
        expect.stringContaining('autoLockJob: completed'),
      );
    });

    it('should not log if no markets were locked or failed', async () => {
      (runAutoLockMarketsJob as jest.Mock).mockResolvedValue({
        locked: 0,
        failed: 0,
      });

      startAutoLockCron();

      const [, callback] = mockCronSchedule.mock.calls[0];
      await callback();

      // Should not call info (guarded by if locked > 0 || failed > 0)
      const infoCalls = (logger.info as jest.Mock).mock.calls.filter((call) =>
        call[0].toString().includes('autoLockJob: completed'),
      );
      expect(infoCalls).toHaveLength(0);
    });

    it('should skip execution if previous run is still in progress', async () => {
      let resolveFirstRun: (() => void) | null = null;
      (runAutoLockMarketsJob as jest.Mock).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFirstRun = resolve;
          }),
      );

      startAutoLockCron();
      const [, callback] = mockCronSchedule.mock.calls[0];

      // Start first run (will hang)
      const firstRunPromise = callback();

      // Fire cron again before first run completes
      callback();

      // Verify skip was logged
      expect((logger.warn as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('autoLockJob: previous run still in progress'),
      );

      // runAutoLockMarketsJob should only be called once
      expect(runAutoLockMarketsJob).toHaveBeenCalledTimes(1);

      // Clean up
      if (resolveFirstRun) resolveFirstRun();
      await firstRunPromise;
    });

    it('should handle errors gracefully', async () => {
      const testError = new Error('Contract error');
      (runAutoLockMarketsJob as jest.Mock).mockRejectedValue(testError);

      startAutoLockCron();

      const [, callback] = mockCronSchedule.mock.calls[0];
      await callback();

      expect((logger.error as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ err: testError }),
        expect.stringContaining('autoLockJob: failed'),
      );
    });

    it('should be disabled when AUTO_LOCK_CRON_DISABLED is true', () => {
      process.env.AUTO_LOCK_CRON_DISABLED = 'true';

      startAutoLockCron();

      expect(mockCronSchedule).not.toHaveBeenCalled();
      expect((logger.info as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('Auto-lock cron job is disabled'),
      );
    });

    it('should reset running flag even if job throws', async () => {
      (runAutoLockMarketsJob as jest.Mock).mockRejectedValue(new Error('Error'));

      startAutoLockCron();
      const [, callback] = mockCronSchedule.mock.calls[0];

      // First call throws
      await callback();

      // Second call should execute (flag was reset in finally block)
      (runAutoLockMarketsJob as jest.Mock).mockClear();
      (runAutoLockMarketsJob as jest.Mock).mockResolvedValue({ locked: 1, failed: 0 });

      await callback();

      expect(runAutoLockMarketsJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrent cron jobs', () => {
    it('should allow both resolution and lock jobs to run independently', async () => {
      startAutoResolutionCron();
      startAutoLockCron();

      // Extract callbacks
      const [resolutionPattern, resolutionCallback] = mockCronSchedule.mock.calls[0];
      const [lockPattern, lockCallback] = mockCronSchedule.mock.calls[1];

      expect(resolutionPattern).toBe('*/10 * * * *');
      expect(lockPattern).toBe('* * * * *');

      // Fire both
      await resolutionCallback();
      await lockCallback();

      // Both should have been called
      expect(runAutoResolutionJob).toHaveBeenCalledTimes(1);
      expect(runAutoLockMarketsJob).toHaveBeenCalledTimes(1);
    });

    it('should not block lock job if resolution job is running', async () => {
      let resolveResolution: (() => void) | null = null;
      (runAutoResolutionJob as jest.Mock).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveResolution = resolve;
          }),
      );

      startAutoResolutionCron();
      startAutoLockCron();

      const [, resolutionCallback] = mockCronSchedule.mock.calls[0];
      const [, lockCallback] = mockCronSchedule.mock.calls[1];

      // Start resolution (will hang)
      const resolutionPromise = resolutionCallback();

      // Lock should execute immediately (not blocked)
      (runAutoLockMarketsJob as jest.Mock).mockResolvedValue({ locked: 1, failed: 0 });
      await lockCallback();

      expect(runAutoLockMarketsJob).toHaveBeenCalledTimes(1);

      // Clean up
      if (resolveResolution) resolveResolution();
      await resolutionPromise;
    });
  });

  describe('edge cases and error scenarios', () => {
    it('should handle multiple consecutive calls without deadlock', async () => {
      (runAutoResolutionJob as jest.Mock).mockResolvedValue({
        processed: 1,
        resolved: 1,
        failed: 0,
      });

      startAutoResolutionCron();
      const [, callback] = mockCronSchedule.mock.calls[0];

      // Fire multiple times in sequence
      await callback();
      await callback();
      await callback();

      expect(runAutoResolutionJob).toHaveBeenCalledTimes(3);
    });

    it('should log when job completes and stats are returned', async () => {
      (runAutoResolutionJob as jest.Mock).mockResolvedValue({
        processed: 10,
        resolved: 8,
        failed: 2,
      });

      startAutoResolutionCron();
      const [, callback] = mockCronSchedule.mock.calls[0];

      await callback();

      const infoCalls = (logger.info as jest.Mock).mock.calls;
      expect(infoCalls.some((call) =>
        call[0]?.toString().includes('autoResolutionJob: completed'),
      )).toBe(true);
    });

    it('should handle job returning undefined gracefully', async () => {
      (runAutoResolutionJob as jest.Mock).mockResolvedValue(undefined);

      startAutoResolutionCron();
      const [, callback] = mockCronSchedule.mock.calls[0];

      // Should not throw
      await expect(callback()).resolves.toBeUndefined();
    });

    it('should handle job returning empty stats', async () => {
      (runAutoResolutionJob as jest.Mock).mockResolvedValue({
        processed: 0,
        resolved: 0,
        failed: 0,
      });

      startAutoResolutionCron();
      const [, callback] = mockCronSchedule.mock.calls[0];

      await callback();

      expect((logger.info as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ processed: 0 }),
        expect.any(String),
      );
    });
  });
});
