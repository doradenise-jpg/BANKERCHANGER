/**
 * Health monitoring for indexer service
 * Tracks last ledger processed and cursor age for K8s liveness/readiness probes
 */

interface HealthState {
  lastLedger: number | null;
  lastUpdate: Date | null;
}

const state: HealthState = {
  lastLedger: null,
  lastUpdate: null,
};

/**
 * Update the last processed ledger
 */
export function updateLastLedger(ledger: number): void {
  state.lastLedger = ledger;
  state.lastUpdate = new Date();
}

/**
 * Get the current health state
 */
export function getHealthState(): { lastLedger: number | null; cursorAge: number | null } {
  const cursorAge = state.lastUpdate ? Date.now() - state.lastUpdate.getTime() : null;
  
  return {
    lastLedger: state.lastLedger,
    cursorAge,
  };
}
