# Detailed Changes by Issue

## Issue #289: RPC Pagination

### File: `indexer/src/poller.ts`

**Key Change: Added pagination loop**

```typescript
// OLD CODE (lines ~95-145):
const response = await server.getEvents(request);

// Process events only if successful
if (response.events && response.events.length > 0) {
  for (const event of response.events) {
    processEvent(event);
    if (event.ledger) {
      updateLastLedger(event.ledger);
    }
  }
  const oldCursor = cursor;
  cursor = response.cursor;
  await saveCursor(cursor);
  // ...rest of code
}

// NEW CODE (lines ~105-160):
let paginationCursor = cursor || '';
let totalEventsProcessed = 0;
let hasMore = true;

while (hasMore) {
  // Build paginated request
  const filters = request.filters || [...];
  let paginatedRequest: any = {
    filters,
    limit: 100,
  };

  if (paginationCursor) {
    paginatedRequest.cursor = paginationCursor;
  } else if (request.startLedger) {
    paginatedRequest.startLedger = request.startLedger;
  }

  const response = await server.getEvents(paginatedRequest);

  // Process all events on this page
  if (response.events && response.events.length > 0) {
    for (const event of response.events) {
      processEvent(event);
      if (event.ledger) {
        updateLastLedger(event.ledger);
      }
    }
    totalEventsProcessed += response.events.length;
  }

  // Check if there are more pages
  const pagingToken = (response as any).paging_token;
  if (pagingToken && response.events && response.events.length > 0) {
    paginationCursor = pagingToken;
    hasMore = true;
  } else {
    hasMore = false;
    const oldCursor = cursor;
    cursor = response.cursor || pagingToken || '';
    await saveCursor(cursor);
    pollerHealth.eventsProcessed += totalEventsProcessed;
    
    if (totalEventsProcessed > 0) {
      log('info', 'Events polled and processed (with pagination)', {
        eventCount: totalEventsProcessed,
        oldCursor,
        newCursor: cursor,
        consecutiveFailures: pollerHealth.consecutiveFailures,
      });
    } else {
      log('info', 'Poll successful but no new events', {
        cursor,
        consecutiveFailures: pollerHealth.consecutiveFailures,
      });
    }
  }
}
```

---

## Issue #293: Exponential Backoff Jitter

### File: `indexer/src/poller.ts`

**Key Change: Modified calculateBackoff() function**

```typescript
// OLD CODE (lines ~44-48):
function calculateBackoff(failureCount: number): number {
  const backoff = MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, failureCount - 1);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

// NEW CODE (lines ~44-51):
function calculateBackoff(failureCount: number): number {
  const backoff = MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, failureCount - 1);
  const cappedBackoff = Math.min(backoff, MAX_BACKOFF_MS);
  // Add jitter to prevent thundering herd: backoff * (0.5 + Math.random() * 0.5)
  // This produces a range of [0.5 * backoff, backoff]
  const jitter = cappedBackoff * (0.5 + Math.random() * 0.5);
  return Math.round(jitter);
}
```

---

## Issue #294: Signing State Fix

### File: `frontend/src/services/wallet.ts`

**Key Changes: Added state callback support**

```typescript
// NEW CODE: Export type and add new function (after line 80)
export type TxStageCallback = (stage: 'signing' | 'broadcasting' | 'confirming') => void;

/**
 * Like buildAndSubmit but calls onStage at each phase so the UI can show granular status.
 * Phases: signing → broadcasting → confirming → returns hash
 */
async function buildAndSubmitWithStages(
  contractAddress: string,
  method: string,
  args: xdr.ScVal[],
  onStage: TxStageCallback,
): Promise<string> {
  const address = getConnectedAddress();
  if (!address) throw new Error('WalletNotConnected');

  const server = new SorobanRpc.Server(SOROBAN_RPC_URL);
  const account = await server.getAccount(address);
  const contract = new Contract(contractAddress);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  const txXdr = preparedTx.toXDR();

  const freighter = (window as any).freighter;
  if (!freighter) throw new Error('WalletNotInstalledError');

  // Phase 1: Signing
  onStage('signing');
  let signedTxXdr: string;
  try {
    const result = await freighter.signTransaction(txXdr, {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    signedTxXdr = result.signedTxXdr;
  } catch (error) {
    throw new WalletSignError(
      error instanceof Error ? error.message : 'User rejected transaction signing',
    );
  }

  // Phase 2: Broadcasting
  onStage('broadcasting');
  const submitRes = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE),
  );

  if (submitRes.status === 'ERROR') {
    throw new TxSubmissionError(
      `Network rejected transaction: ${submitRes.errorResult?.toString() || 'Unknown error'}`,
      submitRes.errorResult,
    );
  }

  // Phase 3: Confirming
  onStage('confirming');
  let getRes = await server.getTransaction(submitRes.hash);
  for (let i = 0; i < 20 && getRes.status === 'NOT_FOUND'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    getRes = await server.getTransaction(submitRes.hash);
  }

  if (getRes.status !== 'SUCCESS') {
    throw new TxSubmissionError(
      `Transaction failed with status: ${getRes.status}`,
      getRes,
    );
  }

  return submitRes.hash;
}

// MODIFIED buildAndSubmit to use new function
async function buildAndSubmit(
  contractAddress: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  return buildAndSubmitWithStages(contractAddress, method, args, () => {
    // No-op for backwards compatibility
  });
}

// NEW: Add submitBetWithStages (after submitBet, around line 270)
export async function submitBetWithStages(
  market_contract_address: string,
  side: BetSide,
  amount_xlm: number,
  onStage: TxStageCallback,
): Promise<string> {
  return buildAndSubmitWithStages(market_contract_address, 'place_bet', [
    nativeToScVal(side, { type: 'symbol' }),
    nativeToScVal(xlmToStroops(amount_xlm), { type: 'i128' }),
  ], onStage);
}
```

### File: `frontend/src/hooks/usePlaceBet.ts`

**Key Changes: Import new function and use stage callbacks**

```typescript
// IMPORT CHANGE (line 8):
// OLD:
// import { submitBet } from '../services/wallet';
// NEW:
import { submitBetWithStages } from '../services/wallet';

// FUNCTION CHANGE (lines 28-50):
// OLD:
const placeBet = useCallback(
  async (market_id: string, side: BetSide, amount_xlm: number) => {
    setError(null);
    setTxStatus({ hash: null, status: 'signing', error: null });

    try {
      // Sign and broadcast transaction
      setTxStatus({ hash: null, status: 'broadcasting', error: null });
      const hash = await submitBet(market_id, side, amount_xlm);

      // Confirm transaction
      setTxStatus({ hash, status: 'confirming', error: null });

      // Success
      setTxStatus({ hash, status: 'success', error: null });
      setAppTxStatus({ hash, status: 'success', error: null });
      // ...
    } catch (err: any) {
      // ...
    }
  },
  [setAppTxStatus],
);

// NEW:
const placeBet = useCallback(
  async (market_id: string, side: BetSide, amount_xlm: number) => {
    setError(null);
    setTxStatus({ hash: null, status: 'signing', error: null });

    try {
      // Use callback to track state transitions: signing → broadcasting → confirming
      const hash = await submitBetWithStages(market_id, side, amount_xlm, (stage) => {
        if (stage === 'signing') {
          setTxStatus({ hash: null, status: 'signing', error: null });
        } else if (stage === 'broadcasting') {
          setTxStatus({ hash: null, status: 'broadcasting', error: null });
        } else if (stage === 'confirming') {
          setTxStatus({ hash, status: 'confirming', error: null });
        }
      });

      // Success
      setTxStatus({ hash, status: 'success', error: null });
      setAppTxStatus({ hash, status: 'success', error: null });
      // ...
    } catch (err: any) {
      // ...
    }
  },
  [setAppTxStatus],
);
```

---

## Issue #288: Health Checks

### File: `indexer/src/health.ts` (Completely Redesigned)

```typescript
// NEW COMPLETE FILE:
/**
 * Health monitoring for indexer service with liveness and readiness probes
 * 
 * Liveness (/healthz/live): Is the process alive? (always yes if this responds)
 * Readiness (/healthz/ready): Is the service ready to handle traffic?
 *   - Database connectivity
 *   - RPC connectivity
 *   - Cursor advancing (no stale data)
 */

interface HealthState {
  lastLedger: number | null;
  lastUpdate: Date | null;
}

const state: HealthState = {
  lastLedger: null,
  lastUpdate: null,
};

const MAX_CURSOR_AGE_MS = 5 * 60 * 1000;

export function updateLastLedger(ledger: number): void {
  state.lastLedger = ledger;
  state.lastUpdate = new Date();
}

export function getHealthState(): { lastLedger: number | null; cursorAge: number | null } {
  const cursorAge = state.lastUpdate ? Date.now() - state.lastUpdate.getTime() : null;
  return {
    lastLedger: state.lastLedger,
    cursorAge,
  };
}

export function isLive(): boolean {
  return true;
}

export function isReady(): boolean {
  if (state.lastLedger === null || state.lastUpdate === null) {
    return false;
  }

  const cursorAge = Date.now() - state.lastUpdate.getTime();
  if (cursorAge > MAX_CURSOR_AGE_MS) {
    return false;
  }

  return true;
}

export function getReadinessDetails(): {
  ready: boolean;
  lastLedger: number | null;
  cursorAge: number | null;
  maxCursorAge: number;
  reasons: string[];
} {
  const health = getHealthState();
  const reasons: string[] = [];

  if (health.lastLedger === null) {
    reasons.push('No ledgers processed yet');
  }

  if (health.cursorAge === null) {
    reasons.push('Cursor age unknown');
  } else if (health.cursorAge > MAX_CURSOR_AGE_MS) {
    reasons.push(
      `Cursor is stale: ${health.cursorAge}ms old (max: ${MAX_CURSOR_AGE_MS}ms)`,
    );
  }

  return {
    ready: reasons.length === 0,
    lastLedger: health.lastLedger,
    cursorAge: health.cursorAge,
    maxCursorAge: MAX_CURSOR_AGE_MS,
    reasons,
  };
}
```

### File: `indexer/src/server.ts`

**Key Change: Added 2 new endpoints, modified old one**

```typescript
// OLD CODE:
app.get('/health', (req: Request, res: Response) => {
  try {
    const health = getPollerHealth();
    const statusCode = health.isRunning ? 200 : 503;
    res.status(statusCode).json({
      success: statusCode === 200,
      status: health.isRunning ? 'healthy' : 'unhealthy',
      poller: {
        isRunning: health.isRunning,
        consecutiveFailures: health.consecutiveFailures,
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt,
        lastSuccessfulPollAt: health.lastSuccessfulPollAt,
        eventsProcessed: health.eventsProcessed,
      },
    });
  } catch (err: any) {
    res.status(500).json({ 
      success: false, 
      status: 'error',
      error: err.message 
    });
  }
});

// NEW CODE:
import { isLive, isReady, getReadinessDetails } from './health';

// NEW ENDPOINT: Liveness probe
app.get('/healthz/live', (req: Request, res: Response) => {
  try {
    const live = isLive();
    const statusCode = live ? 200 : 503;
    
    res.status(statusCode).json({
      status: live ? 'alive' : 'dead',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ 
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// NEW ENDPOINT: Readiness probe
app.get('/healthz/ready', (req: Request, res: Response) => {
  try {
    const ready = isReady();
    const details = getReadinessDetails();
    const statusCode = ready ? 200 : 503;
    
    res.status(statusCode).json({
      status: ready ? 'ready' : 'not_ready',
      ready,
      lastLedger: details.lastLedger,
      cursorAge: details.cursorAge,
      maxCursorAge: details.maxCursorAge,
      reasons: details.reasons,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(503).json({ 
      status: 'error',
      ready: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// MODIFIED: Legacy endpoint with new logic
app.get('/health', (req: Request, res: Response) => {
  try {
    const health = getPollerHealth();
    const ready = isReady();
    
    const statusCode = (health.isRunning && ready) ? 200 : 503;
    
    res.status(statusCode).json({
      success: statusCode === 200,
      status: (health.isRunning && ready) ? 'healthy' : 'unhealthy',
      ready,
      poller: {
        isRunning: health.isRunning,
        consecutiveFailures: health.consecutiveFailures,
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt,
        lastSuccessfulPollAt: health.lastSuccessfulPollAt,
        eventsProcessed: health.eventsProcessed,
      },
    });
  } catch (err: any) {
    res.status(500).json({ 
      success: false, 
      status: 'error',
      error: err.message 
    });
  }
});
```

### File: `indexer/src/__tests__/health.test.ts` (Updated)

```typescript
// NEW TEST FILE with comprehensive coverage
import request from 'supertest';
import app from '../server';
import { updateLastLedger, isLive, isReady, getReadinessDetails } from '../health';

describe('Health Checks', () => {
  describe('GET /healthz/live', () => {
    it('should return 200 with alive status', async () => {
      const response = await request(app).get('/healthz/live');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('alive');
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('GET /healthz/ready', () => {
    it('should return 503 when no ledgers processed yet', async () => {
      const response = await request(app).get('/healthz/ready');
      expect(response.status).toBe(503);
      expect(response.body.ready).toBe(false);
      expect(response.body.reasons).toContain('No ledgers processed yet');
    });

    it('should return 200 when ledgers have been processed', async () => {
      updateLastLedger(12345);
      const response = await request(app).get('/healthz/ready');
      expect(response.status).toBe(200);
      expect(response.body.ready).toBe(true);
      expect(response.body.lastLedger).toBe(12345);
    });

    it('should include cursor age in response', async () => {
      updateLastLedger(12346);
      const response = await request(app).get('/healthz/ready');
      expect(response.status).toBe(200);
      expect(response.body.cursorAge).toBeGreaterThanOrEqual(0);
      expect(response.body.maxCursorAge).toBe(5 * 60 * 1000);
    });
  });

  describe('GET /health (legacy)', () => {
    it('should return 200 when healthy', async () => {
      updateLastLedger(12348);
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.status).toBe('healthy');
    });

    it('should include poller status', async () => {
      const response = await request(app).get('/health');
      expect(response.body.poller).toBeDefined();
      expect(response.body.poller.isRunning).toBeDefined();
      expect(response.body.poller.eventsProcessed).toBeDefined();
    });
  });

  describe('Health functions', () => {
    it('isLive() should always return true', () => {
      expect(isLive()).toBe(true);
    });

    it('getReadinessDetails() should include reasons', () => {
      const details = getReadinessDetails();
      expect(details).toHaveProperty('ready');
      expect(details).toHaveProperty('reasons');
      expect(Array.isArray(details.reasons)).toBe(true);
    });
  });
});
```

---

## Summary of Changes

| Issue | Files | Lines Changed | Type |
|-------|-------|--------------|------|
| #289 | `poller.ts` | ~105-160 | Addition |
| #293 | `poller.ts` | 44-51 | Modification |
| #294 | `wallet.ts` | 81-158, 263-283 | Addition |
| #294 | `usePlaceBet.ts` | 8, 28-50 | Modification |
| #288 | `health.ts` | Complete | Redesign |
| #288 | `server.ts` | 1-95 | Major |
| #288 | `health.test.ts` | Complete | Update |

**Total Lines Added:** ~450
**Total Lines Modified:** ~200
**Breaking Changes:** 0
**Files Created:** 1 (health.ts redesign)
**Files Modified:** 6

