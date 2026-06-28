# API Rate Limits

BoxMeOut enforces rate limits on all API endpoints to protect against abuse and ensure fair access for all consumers.

## Rate Limit Overview

Rate limits are enforced using Redis-backed counters. Each route group has its own limit configuration.

| Route Prefix | Window | Max Requests | Keyed By | Notes |
|-------------|--------|-------------|----------|-------|
| `/auth` | 60 seconds | 10 | IP address | Login, registration, password reset |
| `/api` | 60 seconds | 60 | IP address | Public API (markets, stats, portfolio) |
| `/api/oracle` | 60 seconds | 10 | IP address | Oracle report submission (stricter) |
| `/api/admin` | 60 seconds | 20 | IP address | Admin operations |
| `/trading/bet` | 60 seconds | 60 | User ID | Bet placement |
| `/wallet/withdraw` | 60 seconds | 5 | User ID | Withdrawal requests |

## Rate Limit Headers

Every response includes the following rate limit information:

| Header | Description |
|--------|-------------|
| `Retry-After` | Seconds until the rate limit window resets (only on 429 responses) |

## 429 Response

When a rate limit is exceeded, the API returns:

```json
{
  "success": false,
  "message": "Too Many Requests"
}
```

**HTTP Status:** `429 Too Many Requests`

The `Retry-After` header indicates how many seconds the client should wait before retrying.

## Client Best Practices

1. **Respect `Retry-After`** — When you receive a 429, wait for the duration specified in the `Retry-After` header before retrying.
2. **Use exponential backoff** — If you consistently hit limits, implement exponential backoff with jitter.
3. **Cache responses** — Many market data endpoints return cached data. Avoid polling more frequently than the cache TTL (30 seconds).
4. **Batch where possible** — Use list endpoints (`GET /api/markets`) instead of polling individual markets.
5. **Authenticate** — Some rate limits key by user ID, which provides separate limits per user vs. shared IP limits.

## Rate Limit by Key Type

### IP-based Limits

Requests from the same IP address share a rate limit counter. This applies to all public and admin endpoints. If you are behind a shared proxy or NAT, all users sharing that IP will share the same limit.

### User ID-based Limits

Authenticated endpoints (trading, withdrawals) are rate-limited per user ID. This ensures individual users get fair access regardless of their network topology. If the user is not authenticated, the limit falls back to IP-based.

## Examples

### Checking Rate Limit Status

```bash
# Normal request
curl -i https://api.boxmeout.io/api/markets

# Response headers (normal):
# HTTP/1.1 200 OK

# Rate-limited response:
# HTTP/1.1 429 Too Many Requests
# Retry-After: 45
```

### Handling Rate Limits in JavaScript

```typescript
async function fetchWithRetry(url: string, maxRetries = 3): Promise<Response> {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url);

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    return res;
  }

  throw new Error('Max retries exceeded');
}
```
