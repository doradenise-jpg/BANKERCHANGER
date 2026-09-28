/**
 * Pure helpers for detecting ledger re-orgs and missing ledger sequences while
 * polling Soroban RPC events. Kept separate from poller.ts so the detection
 * logic can be unit tested without mocking the RPC client.
 *
 * Supports planned maintenance windows (Issue #691):
 * - Scheduled maintenance windows stored in Redis/memory with TTL
 * - Ledger gaps during maintenance windows are suppressed from alerting
 * - Post-maintenance backfill is automatically queued
 */

/** How many ledgers to rewind and re-fetch once a re-org is detected. */
export const REORG_REWIND_LEDGERS = 5;

/** A gap larger than this many ledgers is logged as a potential missed range. */
export const GAP_WARNING_THRESHOLD = 1;

export interface MaintenanceWindow {
  id: string;
  startLedger?: number;
  endLedger?: number;
  startTime?: number; // Epoch timestamp ms
  endTime?: number;   // Epoch timestamp ms
  createdAt: number;
  ttlSeconds: number;
  description?: string;
  backfillRequired?: boolean;
}

export interface PendingBackfill {
  id: string;
  windowId: string;
  fromLedger: number;
  toLedger: number;
  createdAt: number;
  status: 'pending' | 'in_progress' | 'completed';
}

export type LedgerAnomaly =
  | { type: 'none' }
  | { type: 'reorg'; fromLedger: number; toLedger: number }
  | { type: 'gap'; fromLedger: number; toLedger: number; missingCount: number }
  | {
      type: 'maintenance_gap';
      fromLedger: number;
      toLedger: number;
      missingCount: number;
      windowId: string;
      backfillPending: boolean;
    };

// ─── Maintenance Window Store ────────────────────────────────────────────────

const activeWindows = new Map<string, MaintenanceWindow>();
const pendingBackfillQueue: PendingBackfill[] = [];

/**
 * Schedule a planned maintenance window (stored in Redis/memory with TTL).
 * Ledger gaps occurring during this window are treated as expected downtime
 * and will not trigger alert notifications.
 */
export function scheduleMaintenanceWindow(params: {
  id?: string;
  startLedger?: number;
  endLedger?: number;
  startTime?: number;
  endTime?: number;
  ttlSeconds?: number;
  description?: string;
  backfillRequired?: boolean;
}): MaintenanceWindow {
  const ttlSeconds = params.ttlSeconds ?? 3600; // default 1 hour TTL
  const id = params.id ?? `maint_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();

  const window: MaintenanceWindow = {
    id,
    startLedger: params.startLedger,
    endLedger: params.endLedger,
    startTime: params.startTime ?? now,
    endTime: params.endTime ?? (params.ttlSeconds ? now + params.ttlSeconds * 1000 : undefined),
    createdAt: now,
    ttlSeconds,
    description: params.description ?? 'Scheduled system maintenance',
    backfillRequired: params.backfillRequired ?? true,
  };

  activeWindows.set(id, window);
  return window;
}

/**
 * Return all currently active (non-expired) maintenance windows.
 */
export function getActiveMaintenanceWindows(now: number = Date.now()): MaintenanceWindow[] {
  const result: MaintenanceWindow[] = [];
  for (const [id, win] of activeWindows.entries()) {
    const isExpired = win.ttlSeconds > 0 && (now - win.createdAt) > (win.ttlSeconds * 1000);
    const isPastEndTime = win.endTime !== undefined && now > win.endTime;
    if (isExpired || isPastEndTime) {
      activeWindows.delete(id);
    } else {
      result.push(win);
    }
  }
  return result;
}

/** Cancel / remove a scheduled maintenance window */
export function cancelMaintenanceWindow(id: string): boolean {
  return activeWindows.delete(id);
}

/** Clear all maintenance windows (test helper) */
export function clearMaintenanceWindows(): void {
  activeWindows.clear();
  pendingBackfillQueue.length = 0;
}

/**
 * Checks if a detected ledger gap overlaps with any active maintenance window.
 */
export function findMatchingMaintenanceWindow(
  fromLedger: number,
  toLedger: number,
  timestamp: number = Date.now()
): MaintenanceWindow | null {
  const windows = getActiveMaintenanceWindows(timestamp);

  for (const win of windows) {
    // Check ledger sequence overlap if configured
    if (win.startLedger !== undefined && win.endLedger !== undefined) {
      if (fromLedger >= win.startLedger && toLedger <= win.endLedger) {
        return win;
      }
    }
    // Check time-based window
    if (win.startTime !== undefined && win.endTime !== undefined) {
      if (timestamp >= win.startTime && timestamp <= win.endTime) {
        return win;
      }
    } else if (win.startTime !== undefined && timestamp >= win.startTime) {
      return win;
    }
  }

  return null;
}

/** Queue an automatic backfill job for a gap that occurred during maintenance */
export function queueMaintenanceBackfill(
  windowId: string,
  fromLedger: number,
  toLedger: number
): PendingBackfill {
  const backfill: PendingBackfill = {
    id: `bf_${fromLedger}_${toLedger}_${Date.now()}`,
    windowId,
    fromLedger,
    toLedger,
    createdAt: Date.now(),
    status: 'pending',
  };
  pendingBackfillQueue.push(backfill);
  return backfill;
}

/** Get list of pending backfills awaiting execution */
export function getPendingBackfills(): PendingBackfill[] {
  return pendingBackfillQueue.filter((b) => b.status === 'pending');
}

/** Mark a backfill as completed */
export function completeBackfill(backfillId: string): void {
  const bf = pendingBackfillQueue.find((b) => b.id === backfillId);
  if (bf) {
    bf.status = 'completed';
  }
}

// ─── Anomaly Detection ───────────────────────────────────────────────────────

/**
 * Compare an incoming event's ledger sequence against the last ledger we
 * successfully processed.
 *
 * - `reorg`: the new event's ledger is *behind* the last processed ledger.
 * - `gap`: the new event's ledger jumps ahead by more than expected, meaning
 *   one or more ledgers were skipped (triggers alert metric).
 * - `maintenance_gap`: the gap occurs inside a scheduled maintenance window;
 *   alerting is suppressed and backfill is queued automatically.
 */
export function detectLedgerAnomaly(
  eventLedger: number,
  lastProcessedLedger: number | null,
  eventTimestamp: number = Date.now()
): LedgerAnomaly {
  if (lastProcessedLedger === null) {
    return { type: 'none' };
  }

  if (eventLedger < lastProcessedLedger) {
    return { type: 'reorg', fromLedger: lastProcessedLedger, toLedger: eventLedger };
  }

  const missingCount = eventLedger - lastProcessedLedger - 1;
  if (missingCount > GAP_WARNING_THRESHOLD) {
    const fromLedger = lastProcessedLedger + 1;
    const toLedger = eventLedger - 1;

    // Check if the gap falls within a scheduled maintenance window
    const maintenanceWindow = findMatchingMaintenanceWindow(fromLedger, toLedger, eventTimestamp);
    if (maintenanceWindow) {
      if (maintenanceWindow.backfillRequired) {
        queueMaintenanceBackfill(maintenanceWindow.id, fromLedger, toLedger);
      }
      return {
        type: 'maintenance_gap',
        fromLedger,
        toLedger,
        missingCount,
        windowId: maintenanceWindow.id,
        backfillPending: !!maintenanceWindow.backfillRequired,
      };
    }

    return {
      type: 'gap',
      fromLedger,
      toLedger,
      missingCount,
    };
  }

  return { type: 'none' };
}

/** Safe ledger to resume polling from after a re-org is detected. */
export function computeResyncStartLedger(lastProcessedLedger: number): number {
  return Math.max(1, lastProcessedLedger - REORG_REWIND_LEDGERS);
}
