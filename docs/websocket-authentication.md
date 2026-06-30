# WebSocket Authentication

## Overview

The ActivityFeed WebSocket endpoint (`/ws`) requires JWT authentication to prevent unauthorized access to real-time market activity data.

## Authentication Protocol

### Connection Setup

Include a valid JWT token in the WebSocket upgrade request via query parameter:

```
ws://localhost:3001?token=<JWT_TOKEN>
```

or for HTTPS:

```
wss://example.com?token=<JWT_TOKEN>
```

### Token Requirements

- Must be a valid JWT signed with `JWT_SECRET` (same as used for REST API auth)
- Token format: `Bearer <token>` is NOT used; pass the raw JWT string
- No expiration validation on the server (tokens are validated structurally)

### Authentication Errors

If authentication fails, the server closes the connection with:

- **Close code:** 4001
- **Reason:** "Unauthorized"

Common failure reasons:
- Missing `token` query parameter
- Invalid JWT signature
- Malformed token

## Example: Client Connection

### JavaScript/TypeScript

```typescript
// Get JWT from login endpoint
const loginRes = await fetch('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'user@example.com', password: 'password' }),
});
const { accessToken } = await loginRes.json();

// Connect with token
const ws = new WebSocket(`ws://localhost:3001?token=${accessToken}`);

ws.addEventListener('open', () => {
  // Subscribe to market activity
  ws.send(JSON.stringify({
    type: 'subscribe_activity',
    marketId: 'market-123',
  }));
});

ws.addEventListener('message', (event) => {
  const activity = JSON.parse(event.data);
  console.log('Activity:', activity);
});

ws.addEventListener('close', (event) => {
  if (event.code === 4001) {
    console.error('Authentication failed');
  }
});
```

## Message Protocol

### Subscribe Message

After successful authentication, send:

```json
{
  "type": "subscribe_activity",
  "marketId": "market-xyz"
}
```

### Activity Events

Server sends events in JSON format:

```json
{
  "type": "trade",
  "marketId": "market-xyz",
  "outcomeId": "outcome-a",
  "side": "buy",
  "sharesAmount": 100,
  "priceBps": 5000,
  "timestamp": "2025-01-15T10:30:00Z"
}
```

Event types:
- `trade` — Buy/sell trade executed
- `dispute` — Dispute filed on market
- `resolved` — Market resolved with outcome

## Rate Limiting

- **20 events/sec per market** — Events beyond this are dropped silently
- Applies to all authenticated connections
- Per-market, not per-connection

## Security Considerations

- **Token Reuse:** Tokens are not revoked; use short expiration in the REST API (`JWT_EXPIRES_IN`)
- **Query Parameter:** JWT in URL may be logged by proxies/load balancers; consider HTTPS in production
- **No Per-Message Auth:** Once connected, no further auth checks per message (use connection-level auth)

## Deployment Checklist

- [ ] Ensure `JWT_SECRET` is set in production
- [ ] Use `wss://` (WebSocket Secure) in production
- [ ] Monitor for 4001 close codes to detect auth failures
- [ ] Validate token expiration on client side for graceful reconnect
