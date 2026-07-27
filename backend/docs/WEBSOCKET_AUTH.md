# WebSocket Authentication: First-Message Protocol

## Security Fix Summary

**Issue**: JWT tokens were extracted from WebSocket connection URLs (`?token=...`), causing JWTs to be written to web server access logs in plain text.

**Solution**: Implemented first-message authentication protocol:
1. Accept plain WebSocket connection (no URL parameters)
2. Client must send `{ type: 'auth', token }` message within 5 seconds
3. Only after authentication can client subscribe to market activity
4. Tokens are sent in the WebSocket message body, not in URL query parameters

## Protocol Specification

### Connection Lifecycle

```
Client                          Server
  |                               |
  |------- WS Connect ------------>|
  |                               | (no auth yet)
  |                               | authTimer starts (5s)
  |                               |
  |------ { type: 'auth', token } |
  |                               | (verify token)
  |                               |
  |<--- Connection OK (open)      |
  |     (authTimer canceled)      |
  |                               |
  |---- { type: 'subscribe_activity', marketId: '...' } ---->|
  |                               | (subscribe to market)
  |                               |
  |<---- { type: 'trade', ... }   |
  |<---- { type: 'dispute', ... }  |
  |      (activity events)        |
  |                               |
  |------- Connection Close ----->|
  |                               | (cleanup subscriptions)
```

## Error Codes

| Code | Reason | Description |
|------|--------|-------------|
| 4001 | Authentication timeout | No auth message within 5 seconds |
| 4001 | Authentication failed | Token invalid or expired |
| 4001 | Authentication required | Non-auth message before auth |
| 4002 | Invalid auth message format | Missing or malformed token field |

## Client Implementation

### JavaScript / TypeScript (Recommended)

```typescript
import jwt from 'jsonwebtoken';

const token = await fetchAuthToken(); // Your auth flow

const ws = new WebSocket('ws://api.example.com/realtime');

ws.addEventListener('open', () => {
  // Send auth message immediately after connection
  ws.send(JSON.stringify({
    type: 'auth',
    token: token,
  }));
});

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  
  switch (message.type) {
    case 'trade':
      console.log(`Trade on market ${message.marketId}:`, message);
      break;
    case 'dispute':
      console.log(`Dispute on market ${message.marketId}:`, message);
      break;
    case 'resolved':
      console.log(`Market ${message.marketId} resolved:`, message);
      break;
  }
});

ws.addEventListener('error', (event) => {
  console.error('WebSocket error:', event);
});

ws.addEventListener('close', (event) => {
  if (event.code === 4001) {
    console.error('Authentication failed:', event.reason);
  } else if (event.code === 4002) {
    console.error('Invalid auth message format:', event.reason);
  }
});
```

### Subscribe to Market Activity

```typescript
function subscribeToMarket(ws: WebSocket, marketId: string) {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected');
  }

  ws.send(JSON.stringify({
    type: 'subscribe_activity',
    marketId: marketId,
  }));
}

// Usage
subscribeToMarket(ws, 'market-123');
```

### Python

```python
import websocket
import json
import threading

def on_message(ws, message):
    try:
        data = json.loads(message)
        market_id = data.get('marketId')
        
        if data['type'] == 'trade':
            print(f"Trade on {market_id}: {data}")
        elif data['type'] == 'dispute':
            print(f"Dispute on {market_id}: {data}")
        elif data['type'] == 'resolved':
            print(f"Market {market_id} resolved: {data}")
    except json.JSONDecodeError:
        print(f"Failed to parse message: {message}")

def on_error(ws, error):
    print(f"WebSocket error: {error}")

def on_close(ws, close_status_code, close_msg):
    if close_status_code == 4001:
        print(f"Authentication failed: {close_msg}")
    elif close_status_code == 4002:
        print(f"Invalid auth message: {close_msg}")
    else:
        print(f"Connection closed: {close_status_code} - {close_msg}")

def on_open(ws):
    # Send auth message immediately
    token = get_auth_token()  # Your auth flow
    ws.send(json.dumps({
        'type': 'auth',
        'token': token
    }))

# Create WebSocket connection
ws = websocket.WebSocketApp(
    'ws://api.example.com/realtime',
    on_message=on_message,
    on_error=on_error,
    on_close=on_close,
    on_open=on_open
)

# Run in background thread
wst = threading.Thread(target=ws.run_forever)
wst.daemon = True
wst.start()

# Subscribe to market after a brief delay (to allow auth)
import time
time.sleep(0.5)
ws.send(json.dumps({
    'type': 'subscribe_activity',
    'marketId': 'market-123'
}))
```

### Go

```go
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"

	"github.com/gorilla/websocket"
)

type AuthMessage struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

type SubscribeMessage struct {
	Type     string `json:"type"`
	MarketID string `json:"marketId"`
}

type ActivityEvent struct {
	Type     string `json:"type"`
	MarketID string `json:"marketId"`
	// ... other fields depend on event type
}

func main() {
	token := getAuthToken() // Your auth flow
	
	wsURL := url.URL{
		Scheme: "ws",
		Host:   "api.example.com",
		Path:   "/realtime",
	}

	conn, _, err := websocket.DefaultDialer.Dial(wsURL.String(), nil)
	if err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}
	defer conn.Close()

	// Send auth message immediately
	authMsg := AuthMessage{
		Type:  "auth",
		Token: token,
	}
	
	if err := conn.WriteJSON(authMsg); err != nil {
		log.Fatalf("Failed to send auth: %v", err)
	}

	// Handle messages
	for {
		var event ActivityEvent
		err := conn.ReadJSON(&event)
		if err != nil {
			log.Printf("WebSocket error: %v", err)
			break
		}

		switch event.Type {
		case "trade":
			fmt.Printf("Trade on market %s\n", event.MarketID)
		case "dispute":
			fmt.Printf("Dispute on market %s\n", event.MarketID)
		case "resolved":
			fmt.Printf("Market %s resolved\n", event.MarketID)
		}
	}
}

func subscribeToMarket(conn *websocket.Conn, marketID string) error {
	subMsg := SubscribeMessage{
		Type:     "subscribe_activity",
		MarketID: marketID,
	}
	return conn.WriteJSON(subMsg)
}
```

## Security Properties

### What's Fixed

✅ **JWTs no longer in URL query parameters**
- Prevents tokens from appearing in:
  - Web server access logs
  - Browser history
  - URL bars
  - Proxy logs
  - CDN logs

✅ **Tokens sent in message body**
- Only visible in WebSocket frame data
- Requires access to WebSocket traffic
- Protected by TLS/WSS encryption

✅ **Time-limited authentication**
- 5-second window to send auth message
- Prevents connection hoarding
- Reduces attack surface

### Remaining Security Measures

1. **Always use WSS (WebSocket Secure)** over TLS in production
   ```typescript
   // Production
   const ws = new WebSocket('wss://api.example.com/realtime');
   
   // Development only
   const ws = new WebSocket('ws://localhost:3001/realtime');
   ```

2. **Rotate JWT tokens regularly**
   - Implement short-lived access tokens (15 min)
   - Use refresh tokens for renewal
   - Revoke tokens on logout

3. **Monitor WebSocket connections**
   - Log auth attempts with request IDs
   - Alert on repeated failures from same IP
   - Track subscription patterns

4. **Implement rate limiting**
   - Per-IP connection limits
   - Per-market event rate limits (20 events/sec)
   - Message frequency per connection

## Testing the Protocol

### Manual Test (curl + websocat)

```bash
# Install websocat
cargo install websocat

# Get a valid JWT token
TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password"}' \
  | jq -r '.accessToken')

# Connect to WebSocket (will timeout without auth)
websocat ws://localhost:3001/realtime

# In another terminal, send auth via stdin
{"type":"auth","token":"$TOKEN"}

# Then subscribe
{"type":"subscribe_activity","marketId":"market-123"}
```

### Automated Test

```typescript
describe('WebSocket first-message auth', () => {
  it('should require auth within 5 seconds', async () => {
    const ws = new WebSocket('ws://localhost:3001/realtime');
    await connectPromise(ws);
    
    // Wait for connection to close due to auth timeout
    const closed = await closePromise(ws);
    expect(closed.code).toBe(4001);
  });

  it('should accept valid token in first message', async () => {
    const token = jwt.sign({ userId: 'test' }, JWT_SECRET);
    const ws = new WebSocket('ws://localhost:3001/realtime');
    await connectPromise(ws);
    
    ws.send(JSON.stringify({ type: 'auth', token }));
    
    // Should not close
    await sleep(1000);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
```

## Migration Guide (from URL-based auth)

### Before (Insecure)

```typescript
const token = localStorage.getItem('authToken');
// ❌ Token visible in browser URL bar, server logs
const ws = new WebSocket(`ws://api.example.com/realtime?token=${token}`);
```

### After (Secure)

```typescript
const token = localStorage.getItem('authToken');
// ✅ Token not in URL
const ws = new WebSocket('ws://api.example.com/realtime');

ws.addEventListener('open', () => {
  // ✅ Send token in message body
  ws.send(JSON.stringify({
    type: 'auth',
    token: token
  }));
});
```

## Monitoring & Troubleshooting

### Key Metrics to Track

```typescript
// Log successful authentications
[req-123456-abc] WebSocket connection authenticated

// Log auth failures
[req-234567-def] Authentication failed: invalid token
[req-345678-ghi] Authentication timeout

// Log subscription activity
[req-123456-abc] Subscribed to market market-123
```

### Common Issues

1. **"Authentication timeout" errors**
   - Client not sending auth message quickly enough
   - Check network latency
   - Verify client is sending correct message format

2. **"Invalid auth message format"**
   - Missing `type: 'auth'` field
   - Missing or malformed `token` field
   - Verify JSON serialization

3. **"Authentication failed"**
   - Token expired or invalid
   - Token signed with wrong key
   - Clock skew between client and server

4. **Events not arriving**
   - Verify subscription message sent after auth
   - Check market ID is correct
   - Ensure client subscribed to correct market
