/**
 * Pure helpers for detecting ledger re-orgs and missing ledger sequences while
 * polling Soroban RPC events. Kept separate from poller.ts so the detection
 * logic can be unit tested without mocking the RPC client.
 */

/** How many ledgers to rewind and re-fetch once a re-org is detected. */
export const REORG_REWIND_LEDGERS = 5;

/** A gap larger than this many ledgers is logged as a potential missed range. */
export const GAP_WARNING_THRESHOLD = 1;

export type LedgerAnomaly =
  | { type: 'none' }
  | { type: 'reorg'; fromLedger: number; toLedger: number }
  | { type: 'gap'; fromLedger: number; toLedger: number; missingCount: number };

/**
 * Compare an incoming event's ledger sequence against the last ledger we
 * successfully processed.
 *
 * - `reorg`: the new event's ledger is *behind* the last processed ledger,
 *   meaning the chain view we advanced past has since changed.
 * - `gap`: the new event's ledger jumps ahead by more than expected, meaning
 *   one or more ledgers were skipped (e.g. RPC pruned history or a poll was
 *   missed entirely).
 */
export function detectLedgerAnomaly(
  eventLedger: number,
  lastProcessedLedger: number | null
): LedgerAnomaly {
  if (lastProcessedLedger === null) {
    return { type: 'none' };
  }

  if (eventLedger < lastProcessedLedger) {
    return { type: 'reorg', fromLedger: lastProcessedLedger, toLedger: eventLedger };
  }

  const missingCount = eventLedger - lastProcessedLedger - 1;
  if (missingCount > GAP_WARNING_THRESHOLD) {
    return {
      type: 'gap',
      fromLedger: lastProcessedLedger + 1,
      toLedger: eventLedger - 1,
      missingCount,
    };
  }

  return { type: 'none' };
}

/** Safe ledger to resume polling from after a re-org is detected. */
export function computeResyncStartLedger(lastProcessedLedger: number): number {
  return Math.max(1, lastProcessedLedger - REORG_REWIND_LEDGERS);
}
