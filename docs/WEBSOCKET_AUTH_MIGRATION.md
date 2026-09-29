# WebSocket Authentication Migration

## Summary

Migrated WebSocket authentication from query parameter-based to first-message authentication to prevent JWT tokens from being logged in access logs.

**Status:** Complete and tested ✅

## Problem

The previous implementation extracted the JWT from the WebSocket URL query parameter (`?token=...`). Web server access logs record full URLs including query parameters, exposing JWT tokens in plain text in log files.

## Solution

Implemented first-message authentication:
1. Accept plain WebSocket connections without authentication
2. Require a `{ type: 'auth', token }` message within 5 seconds
3. Verify the JWT in the message body instead of the URL
4. Only allow subscription messages after successful authentication
5. Close connections that don't authenticate within 5 seconds

## Changes

### Backend (`backend/src/websocket/realtime.ts`)

**New message type:**
```typescript
type AuthMsg = { type: 'auth'; token: string };
```

**New auth timeout:**
- 5-second deadline for clients to send auth message
- Prevents resource exhaustion from long-lived unauthenticated connections

**Updated connection handling:**
- Accept all connections without validation
- Track auth timeout per socket using `WeakMap<WebSocket, NodeJS.Timeout>`
- Validate authentication in message handler, not in connection handler
- Clear timeout and track authenticated connections in `WeakSet<WebSocket>`
- Cleanup function (`cleanupSocket`) properly handles both auth timeouts and subscriptions

**Error responses:**
- `4001 "Authentication timeout"` — No auth message within 5 seconds
- `4001 "Expected auth message"` — First message was not an auth message
- `4001 "Invalid token"` — JWT verification failed

### Tests (`backend/tests/integration/activity-feed.integration.test.ts`)

Updated all 7 integration tests:
1. ✅ Delivers trade events after auth + subscription
2. ✅ Doesn't deliver events to unsubscribed markets
3. ✅ Rate-limits to 20 events/sec per market
4. ✅ Removes empty subscription sets (memory leak test)
5. ✅ Rejects connections without auth (5-second timeout)
6. ✅ Rejects connections with invalid token
7. ✅ Rejects subscription messages before auth

### Documentation (`docs/websocket-authentication.md`)

- Removed query parameter approach
- Added first-message authentication protocol with setup steps
- Updated client example with new auth flow
- Added error code table
- Enhanced security considerations
- Updated deployment checklist

## Client Migration Guide

**Before:**
```typescript
const ws = new WebSocket(`ws://localhost:3001?token=${accessToken}`);
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-1' }));
});
```

**After:**
```typescript
const ws = new WebSocket('ws://localhost:3001/');
ws.addEventListener('open', () => {
  // Send auth message first
  ws.send(JSON.stringify({ type: 'auth', token: accessToken }));
});

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'trade' || message.type === 'dispute' || message.type === 'resolved') {
    // Handle activity events
  }
});

// Only subscribe after authentication succeeds
function subscribeToMarket(marketId: string) {
  ws.send(JSON.stringify({ type: 'subscribe_activity', marketId }));
}
```

Public market pages can obtain a short-lived activity-only JWT by posting to
`/auth/activity-feed-token`. Send it in the initial `auth` frame, then subscribe
to the market activity feed. This token cannot subscribe to leaderboard channels.

## Test Results

All 7 integration tests passing:
```
✓ delivers a trade event to a subscribed client after buying shares
✓ does not deliver events to unsubscribed markets
✓ rate-limits to 20 events/sec per market
✓ removes empty subscription sets to prevent memory leaks
✓ rejects connections without valid JWT token
✓ rejects connections with invalid JWT token
✓ rejects subscription messages before authentication
```

## Security Benefits

1. **No token exposure in logs** — JWTs are sent in WebSocket frames, not in HTTP headers or URLs
2. **Defense against token leakage** — Even if server logs are compromised, JWTs are not exposed
3. **Resource efficiency** — 5-second auth timeout prevents accumulation of unauthenticated connections
4. **Clear auth flow** — Explicit authentication message is easier to audit and monitor

## Deployment Notes

1. **Backend is ready** — No configuration changes needed
2. **Client updates required** — All WebSocket clients must be updated to use new auth flow
3. **Monitoring** — Watch for 4001 close codes with `"Authentication timeout"` reason to detect clients that haven't been updated
4. **Backward compatibility** — None; this is a breaking change for all WebSocket clients
