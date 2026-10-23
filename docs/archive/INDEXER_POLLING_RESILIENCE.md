# Fix: Indexer Polling Resilience with Exponential Backoff

## Problem

The indexer's event polling was fragile and susceptible to permanent data loss:

1. **setInterval-based polling** – Doesn't wait for RPC calls to complete
2. **Silent error handling** – Errors logged but execution continues
3. **Cursor advanced on failure** – If RPC fails after advancing cursor, events are lost
4. **No retry mechanism** – Failed polls abandoned immediately
5. **No health visibility** – No way to detect polling failures in production
6. **No re-org handling** – A ledger sequence moving backward (re-org) or a gap in
   processed sequences was indistinguishable from normal operation
7. **No real-time visibility** – Consumers had to poll the REST API to notice new
   invoice state; there was no way to subscribe to ingestion as it happened

### Consequences

- RPC outage → missed events → permanent gaps in database
- No monitoring/alerting for polling failures
- Events indexing unreliable during network issues
- Silent data loss with no visibility
- A re-org could silently corrupt invoice state derived from now-invalid events
- Downstream consumers polled aggressively just to approximate real-time updates

## Solution

### 1. Replaced setInterval with Recursive Async Loop (`indexer/src/poller.ts`)

**Before:**
```typescript
setInterval(async () => {
  try {
    const response = await server.getEvents(request);
    // ... process events
    cursor = response.cursor;  // ❌ Advanced even if next poll fails
    await saveCursor(cursor);
  } catch (err) {
    console.error('Error fetching events:', err);  // ❌ Silent failure
  }
}, 5000);
```

**After:**
```typescript
async function pollLoop(): Promise<void> {
  try {
    const response = await server.getEvents(request);
    
    // Process events ONLY if successful
    if (response.events && response.events.length > 0) {
      for (const event of response.events) {
        processEvent(event);
      }
      // ✓ Cursor advanced ONLY after successful process
      cursor = response.cursor;
      await saveCursor(cursor);
    }

    // ✓ Reset retry counter on success
    pollerHealth.consecutiveFailures = 0;
    
    // ✓ Continue polling immediately
    await pollLoop();
    
  } catch (err) {
    pollerHealth.consecutiveFailures++;
    
    // ✓ Exponential backoff before retry
    const backoffMs = calculateBackoff(pollerHealth.consecutiveFailures);
    log('error', 'Poll failed, scheduling retry', { 
      consecutiveFailures: pollerHealth.consecutiveFailures,
      backoffMs 
    });
    
    await new Promise(resolve => setTimeout(resolve, backoffMs));
    await pollLoop();  // ✓ Retry with backoff
  }
}
```

**Benefits:**
- ✓ Guarantees proper async/await handling
- ✓ Cursor never advanced on failure
- ✓ Automatic retry with backoff
- ✓ Resilient to temporary RPC outages

### 2. Implemented Exponential Backoff (1s → 5min)

**Backoff calculation:**
- Min: 1 second (first retry)
- Multiplier: 2x per failure
- Max: 5 minutes (caps at ~20 retries)

**Progression:**
```
Attempt 1: immediate
Attempt 2: 1s
Attempt 3: 2s
Attempt 4: 4s
Attempt 5: 8s
...
Attempt 20+: 5min (capped)
```

**Reset on success:**
- Any successful poll resets counter to 0
- Next failure starts at 1s backoff again

### 3. Cursor Safety – Never Advance on Failure

**Key invariant:**
```typescript
// Only advance cursor after:
// 1. Events successfully fetched from RPC
// 2. Events successfully processed
// 3. Cursor successfully persisted to storage
cursor = response.cursor;
await saveCursor(cursor);
```

**On failure at any step:**
- Cursor remains unchanged
- Same cursor used for next poll attempt
- Missed events replayed on recovery

### 4. Health Tracking State

```typescript
interface PollerHealth {
  isRunning: boolean;           // Poller active?
  consecutiveFailures: number;  // Failure count for backoff
  lastError: string | null;     // Latest error message
  lastErrorAt: string | null;   // When last error occurred
  lastSuccessfulPollAt: string | null;  // When last success
  eventsProcessed: number;      // Total events indexed
}
```

**Exported via:** `getPollerHealth(): PollerHealth`

### 5. Structured Logging

**All events logged as JSON for log aggregation:**

```typescript
log('error', 'Poll failed, scheduling retry', {
  error: 'Connection refused',
  consecutiveFailures: 3,
  backoffMs: 4000,
  cursor: 'abc123...'
});
```

**Output:**
```json
{
  "timestamp": "2026-06-29T20:51:46.000Z",
  "level": "error",
  "message": "Poll failed, scheduling retry",
  "context": {
    "error": "Connection refused",
    "consecutiveFailures": 3,
    "backoffMs": 4000,
    "cursor": "abc123..."
  }
}
```

### 6. Health Endpoint (`indexer/src/server.ts`)

**New endpoint:** `GET /health`

**Response (healthy):**
```json
{
  "success": true,
  "status": "healthy",
  "poller": {
    "isRunning": true,
    "consecutiveFailures": 0,
    "lastError": null,
    "lastErrorAt": null,
    "lastSuccessfulPollAt": "2026-06-29T20:51:46.123Z",
    "eventsProcessed": 1245
  }
}
```

**Response (degraded, retrying):**
```json
{
  "success": true,
  "status": "healthy",
  "poller": {
    "isRunning": true,
    "consecutiveFailures": 3,
    "lastError": "Connection refused",
    "lastErrorAt": "2026-06-29T20:51:30.000Z",
    "lastSuccessfulPollAt": "2026-06-29T20:50:50.000Z",
    "eventsProcessed": 1245
  }
}
```

**Response (unhealthy):**
```json
{
  "success": false,
  "status": "unhealthy",
  "poller": { ... }
}
```

**HTTP Status Codes:**
- `200 OK` – Poller running, can index events
- `503 Service Unavailable` – Poller stopped, data loss risk

### 7. Re-org and Missing Ledger Sequence Handling (`indexer/src/ledgerContinuity.ts`)

The poller now tracks the last ledger sequence it successfully processed
(persisted alongside the cursor in `cursor.json`) and compares it against
each incoming event's ledger:

- **Re-org** – the incoming event's ledger is *behind* the last processed
  ledger. The poller discards the current cursor and resumes from
  `lastProcessedLedger - REORG_REWIND_LEDGERS` (5 ledgers), so any events
  invalidated by the re-org get safely re-ingested via the existing
  idempotent `upsertInvoice` logic.
- **Gap** – the incoming event's ledger jumps ahead by more than one
  sequence. Logged and counted via `pollerHealth.ledgerGapsDetected`; a
  single skipped ledger (no matching events) is not treated as a gap.

Both conditions are exposed on `/health` (`reorgsDetected`, `lastReorgAt`,
`ledgerGapsDetected`, `lastLedgerGapAt`) and broadcast over the WebSocket
stream as `poller.reorg_detected`.

### 8. Real-Time WebSocket Event Stream (`indexer/src/ws.ts`)

Clients can subscribe to `ws://<host>:<port>/ws` instead of polling the REST
API. On connect they receive a `connected` message; after that, every
processed contract event is pushed as it's ingested:

```json
{ "type": "invoice.funded", "timestamp": "...", "data": { "invoiceId": "INV-1" } }
```

Degraded-state signals are streamed too: `poller.reorg_detected` and
`poller.retry_scheduled` (emitted whenever a failed poll schedules a
backoff retry), so consumers see resilience events live rather than only by
polling `/health`.

### 9. Configurable Backoff (`indexer/src/backoff.ts`)

Backoff parameters were extracted into a standalone module and made tunable
via environment variables, since a fixed 1s–5min curve isn't right for
every RPC provider:

```bash
POLLER_MIN_BACKOFF_MS=1000
POLLER_MAX_BACKOFF_MS=300000
POLLER_BACKOFF_MULTIPLIER=2
```

Invalid or missing values fall back to the defaults above.

## Configuration

### Exponential Backoff Tuning

Set via environment variables (see `indexer/.env.example`):
```bash
POLLER_MIN_BACKOFF_MS=1000        # Start: 1s
POLLER_MAX_BACKOFF_MS=300000      # Cap: 5min
POLLER_BACKOFF_MULTIPLIER=2       # Double each time
```

### Docker Health Check

Already configured in `indexer/Dockerfile`:
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', ...)"
```

## Operational Behavior

### Normal Operation
1. Poller starts, reads last saved cursor
2. Polls events from RPC every ~5 seconds (no fixed interval)
3. On success: processes events, advances cursor, resets failure count
4. On no new events: sleeps briefly, retries

### RPC Outage (5min example)
1. Poll fails → consecutiveFailures = 1, backoff = 1s
2. Poll fails → consecutiveFailures = 2, backoff = 2s
3. Poll fails → consecutiveFailures = 3, backoff = 4s
4. Poll fails → consecutiveFailures = 4, backoff = 8s
5. ...continues backing off up to 5min max...
6. RPC recovers → poll succeeds → cursor advanced → counter reset to 0

### Health Monitoring
```bash
# Check poller health
curl http://localhost:3001/health

# Monitor consecutive failures in production
while true; do
  curl -s http://localhost:3001/health | \
    jq '.poller.consecutiveFailures'
  sleep 10
done

# Alert on consecutive failures > threshold
# E.g., Datadog: poller.consecutiveFailures > 5
```

## Impact

✓ Events missed during RPC outage are replayed after recovery
✓ No more permanent data loss from transient failures
✓ Clear visibility into poller health via `/health` endpoint
✓ Automatic recovery with exponential backoff, tunable per environment
✓ Structured logging for log aggregation and alerts
✓ Monitoring-friendly status codes and metrics
✓ Re-orgs and missing ledger sequences are detected and recovered from
  instead of silently corrupting or losing state
✓ Consumers can subscribe to ingestion in real time over WebSocket instead
  of polling the REST API

## Files Modified

1. `indexer/src/poller.ts`
   - Replaced `setInterval` with recursive async loop
   - Added exponential backoff (1s-5min, now configurable)
   - Added cursor safety (never advance on failure)
   - Added structured logging
   - Exported health state via `getPollerHealth()`
   - Added ledger re-org/gap detection and resync
   - Broadcasts ingested events and degraded-state signals over WebSocket

2. `indexer/src/server.ts`
   - Added `GET /health` endpoint
   - Integrated health state from poller (including re-org/gap counters)
   - Returns appropriate HTTP status codes

3. `indexer/src/ledgerContinuity.ts` (new)
   - Pure functions for detecting re-orgs and ledger gaps
   - Computes the safe resync ledger after a re-org

4. `indexer/src/backoff.ts` (new)
   - Exponential backoff math, extracted for unit testing
   - Reads `POLLER_MIN_BACKOFF_MS` / `POLLER_MAX_BACKOFF_MS` /
     `POLLER_BACKOFF_MULTIPLIER` from the environment

5. `indexer/src/ws.ts` (new)
   - WebSocket server attached to the existing HTTP server at `/ws`
   - Broadcasts ingested events and poller status to connected clients

6. `indexer/src/index.ts`
   - Wires the WebSocket server into the HTTP server on startup

## Testing

```bash
# Simulate RPC failure (kill RPC or set bad URL)
# Expected: consecutive failures increase, backoff grows, no crash

# Recover RPC
# Expected: next poll succeeds, consecutive failures reset to 0, cursor advances

# Monitor health
curl http://localhost:3001/health | jq .

# Subscribe to the real-time event stream
websocat ws://localhost:3001/ws   # or any WebSocket client

# Check logs
docker-compose logs -f indexer
```

Automated coverage lives in `indexer/src/__tests__/`:
`ledgerContinuity.test.ts` (re-org/gap detection), `backoff.test.ts`
(backoff math and env parsing), and `ws.test.ts` (WebSocket broadcast).

---

**Status**: ✅ Implemented. Indexer polling is now resilient to transient failures with exponential backoff and health monitoring.
