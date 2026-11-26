# WebSocket Authentication

## Overview

The WebSocket endpoint is `ws://localhost:3001/ws` (or `wss://` in production). It requires JWT authentication via a first-message protocol, keeping tokens out of URLs and access logs. The root path remains available as a compatibility alias.

## Authentication Protocol

### Connection Setup

1. **Connect without authentication** — Open a WebSocket connection to `/ws` without any credentials:

```
ws://localhost:3001/ws
```

or for HTTPS:

```
wss://example.com/ws
```

2. **Send authentication message within 5 seconds** — After connection opens, send an auth message with your JWT token:

```json
{
  "type": "auth",
  "token": "<JWT_TOKEN>"
}
```

### Token Requirements

- Must be a valid JWT signed with `JWT_ACCESS_SECRET` (falls back to `JWT_SECRET`)
- Token format: pass the raw JWT string (not `Bearer <token>`)
- Expiration and signature are verified by the server.

### Authentication Errors

Connection closes with error codes:

| Close Code | Reason | Cause |
|---|---|---|
| 4001 | `Authentication timeout` | Auth message not sent within 5 seconds |
| 4001 | `Expected auth message` | First message was not an auth message |
| 4001 | `Invalid token` | JWT signature verification failed |

## Example: Client Connection

### JavaScript/TypeScript

```typescript
// Get JWT from login endpoint
const loginRes = await fetch('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'user@example.com', password: 'password' }),
});
const { accessToken } = await loginRes.json();

// Connect to WebSocket (without token in URL)
const ws = new WebSocket('ws://localhost:3001/ws');

ws.addEventListener('open', () => {
  // Send authentication message
  ws.send(JSON.stringify({
    type: 'auth',
    token: accessToken,
  }));
});

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  
  // Handle activity events (received after successful auth and subscription)
  if (message.type === 'trade' || message.type === 'dispute' || message.type === 'resolved') {
    console.log('Activity:', message);
  }
});

ws.addEventListener('close', (event) => {
  if (event.code === 4001) {
    console.error('Authentication failed:', event.reason);
  }
});

ws.addEventListener('error', (event) => {
  console.error('WebSocket error:', event);
});

// After sending auth, subscribe to a market. WebSocket preserves message order.
function subscribeToMarket(marketId: string) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(`/subscribe market:${marketId}`);
  }
}
```

## Message Protocol

### Subscribe Message

After sending the authentication frame, send:

```
/subscribe market:market-xyz
```

The JSON equivalent and legacy activity-feed form are also supported:

```json
{
  "type": "subscribe",
  "channel": "market:market-xyz"
}
```

### Market Events

Market lifecycle changes are sent to every connected worker's subscribers as JSON:

```json
{
  "type": "market_updated",
  "marketId": "market-xyz",
  "data": {
    "side": "fighter_a",
    "amount": "100"
  }
}
```

Market event types:
- `market_updated` — A bet was placed or odds changed
- `market_locked` — Betting was locked
- `market_resolved` — An outcome was resolved
- `market_cancelled` — A market was cancelled

The existing activity event names (`trade`, `market_update`, `resolved`, and `cancelled`) remain available to existing clients.

### Reconnection

Subscriptions belong to a WebSocket connection. On reconnect, authenticate again and resubscribe to every market. Clients should retain their market IDs and resend `/subscribe market:<id>` after each connection opens. Market events are broadcast across backend processes through Redis Pub/Sub.

## Rate Limiting

- **20 events/sec per market** — Events beyond this are dropped silently
- Applies to all authenticated connections
- Per-market, not per-connection

## Security Considerations

- **Token in Access Logs:** Query parameters are NOT logged; the token is only sent as a WebSocket frame, not visible to reverse proxies or load balancers
- **Token Reuse:** Tokens are not revoked; use short expiration in the REST API (`JWT_EXPIRES_IN`)
- **5-Second Deadline:** Clients must authenticate within 5 seconds or the connection is closed (prevents resource exhaustion from unauthenticated connections)
- **No Per-Message Auth:** Once authenticated, no further auth checks per message (connection-level auth only)

## Deployment Checklist

- [ ] Ensure `JWT_SECRET` is set in production
- [ ] Use `wss://` (WebSocket Secure) in production
- [ ] Monitor for 4001 close codes to detect auth failures
- [ ] Client code updated to send auth message instead of token in URL
- [ ] Update client reconnection logic to handle 5-second auth deadline
