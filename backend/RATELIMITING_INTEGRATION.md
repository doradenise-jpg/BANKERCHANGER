# Rate Limiting Integration Guide

This guide shows how to integrate the RateLimitingService into existing BANKERCHANGER routes.

## Quick Start

### 1. Apply Global Rate Limiting

Add middleware to all API routes:

```typescript
// src/index.ts
import express from 'express';
import { rateLimitingMiddleware } from './middleware/rateLimiting.middleware';

const app = express();

// Apply rate limiting to all /api routes
app.use('/api/', rateLimitingMiddleware());

// Your routes
app.post('/api/submit-bet', submitBetHandler);
```

### 2. Apply Per-Endpoint Rate Limiting

For specific expensive endpoints:

```typescript
// src/routes/betting.ts
import { perEndpointRateLimit } from '../middleware/rateLimiting.middleware';

// 10 requests per minute for oracle operations
router.post('/api/oracle/query',
  perEndpointRateLimit(10, 60),
  oracleQueryHandler
);

// 20 requests per minute for market creation
router.post('/api/markets',
  perEndpointRateLimit(20, 60),
  createMarketHandler
);
```

### 3. Manual Rate Limiting in Handlers

For complex scenarios:

```typescript
// src/routes/bets.ts
import { checkLimitByTier } from '../services/rateLimiting.service';
import { logger } from '../utils/logger';

export async function submitBetHandler(
  req: Request & { user?: { id: string } },
  res: Response,
) {
  const userId = req.user?.id || req.ip;
  
  // Check rate limit
  const rateLimitResult = await checkLimitByTier(userId, 'public');
  
  if (!rateLimitResult.allowed) {
    logger.warn({ userId }, 'Bet submission rate limited');
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'You are placing bets too quickly. Please try again later.',
      reset_at: rateLimitResult.reset_at,
    });
  }
  
  // Set headers
  res.set({
    'X-RateLimit-Remaining': rateLimitResult.remaining.toString(),
    'X-RateLimit-Reset': rateLimitResult.reset_at.toString(),
  });
  
  // Process bet submission
  // ... rest of handler
}
```

## Real-World Examples

### Example 1: Public API Endpoint

```typescript
// src/routes/markets.ts
import { Router } from 'express';
import { perEndpointRateLimit } from '../middleware/rateLimiting.middleware';

const router = Router();

// Public endpoint: 60 requests per minute
router.get('/markets',
  perEndpointRateLimit(60, 60),
  async (req, res) => {
    // List all markets
    const markets = await getMarkets();
    res.json(markets);
  }
);

export default router;
```

### Example 2: Oracle Feed Endpoint

```typescript
// src/routes/oracle.ts
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { perEndpointRateLimit } from '../middleware/rateLimiting.middleware';
import { getOraclePrices } from '../services/OracleService';

const router = Router();

// Oracle endpoint: 10 requests per minute (high cost operation)
router.get('/oracle/prices',
  authMiddleware,
  perEndpointRateLimit(10, 60),
  async (req, res) => {
    const prices = await getOraclePrices();
    res.json(prices);
  }
);

export default router;
```

### Example 3: Admin Operations

```typescript
// src/routes/admin.ts
import { Router } from 'express';
import { adminMiddleware } from '../middleware/admin';
import { perEndpointRateLimit } from '../middleware/rateLimiting.middleware';

const router = Router();

// Admin endpoint: 20 requests per minute
router.post('/admin/users/:id/suspend',
  adminMiddleware,
  perEndpointRateLimit(20, 60),
  async (req, res) => {
    const userId = req.params.id;
    await suspendUser(userId);
    res.json({ success: true });
  }
);

export default router;
```

### Example 4: Custom Rate Limiting Logic

```typescript
// src/routes/payments.ts
import { Router } from 'express';
import { checkLimit } from '../services/rateLimiting.service';
import { logger } from '../utils/logger';

const router = Router();

router.post('/payments/withdraw',
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id;
    const amount = req.body.amount;
    
    // Different limits based on amount
    let limit = 100; // 100 withdrawals per hour
    let window = 3600;
    
    if (amount > 10000) {
      limit = 5; // Only 5 large withdrawals per hour
    }
    
    // Check rate limit
    const result = await checkLimit(
      `withdrawal:${userId}:${Math.floor(amount / 1000) * 1000}`,
      limit,
      window
    );
    
    if (!result.allowed) {
      return res.status(429).json({
        error: 'Withdrawal limit exceeded',
        reset_at: result.reset_at,
      });
    }
    
    // Process withdrawal
    logger.info({ userId, amount }, 'Processing withdrawal');
    // ... withdrawal logic
  }
);

export default router;
```

### Example 5: Tiered User Access

```typescript
// src/middleware/tieredRateLimit.ts
import { Request, Response, NextFunction } from 'express';
import { checkLimitByTier } from '../services/rateLimiting.service';

export async function tieredRateLimitMiddleware(
  req: Request & { user?: { id: string; tier: 'free' | 'pro' | 'enterprise' } },
  res: Response,
  next: NextFunction,
) {
  const userId = req.user?.id;
  if (!userId) {
    return next();
  }
  
  // Map user tier to rate limit tier
  let rateLimitTier: 'public' | 'oracle' | 'admin' = 'public';
  if (req.user?.tier === 'enterprise') {
    rateLimitTier = 'admin'; // 20/min
  } else if (req.user?.tier === 'pro') {
    rateLimitTier = 'oracle'; // 10/min  
  } else {
    rateLimitTier = 'public'; // 60/min
  }
  
  const result = await checkLimitByTier(userId, rateLimitTier);
  
  res.set({
    'X-RateLimit-Limit': '60',
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': result.reset_at.toString(),
  });
  
  if (!result.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      tier: req.user?.tier,
      reset_at: result.reset_at,
    });
  }
  
  next();
}
```

### Example 6: Reset User Rate Limit (Admin)

```typescript
// src/routes/admin.ts
import { resetLimit } from '../services/rateLimiting.service';

router.post('/admin/reset-rate-limit/:userId',
  adminMiddleware,
  async (req, res) => {
    const userId = req.params.userId;
    
    // Reset all rate limit counters for user
    await resetLimit(`public:${userId}`);
    await resetLimit(`oracle:${userId}`);
    
    res.json({ 
      success: true, 
      message: `Rate limit reset for user ${userId}` 
    });
  }
);
```

## Configuration Patterns

### Pattern 1: Per-Tier Configuration

```typescript
// src/config/rateLimits.ts
export const RATE_LIMIT_CONFIG = {
  public: {
    limit: 60,
    window: 60, // 60 per minute
  },
  oracle: {
    limit: 10,
    window: 60, // 10 per minute
  },
  admin: {
    limit: 20,
    window: 60, // 20 per minute
  },
  // Per-endpoint overrides
  endpoints: {
    'POST /api/bets': {
      limit: 50,
      window: 60,
    },
    'GET /api/markets': {
      limit: 100,
      window: 60,
    },
    'POST /api/oracle/query': {
      limit: 5,
      window: 60,
    },
  },
};
```

### Pattern 2: Dynamic Rate Limits

```typescript
// src/services/rateLimitConfig.ts
export async function getRateLimitConfig(userId: string) {
  const user = await getUser(userId);
  
  return {
    limit: user.subscription === 'premium' ? 1000 : 60,
    window: 60,
  };
}
```

### Pattern 3: Weighted Rate Limiting

```typescript
// Different costs for different operations
const OPERATION_COSTS = {
  'list-markets': 1,
  'create-bet': 5,
  'oracle-query': 20,
  'export-data': 50,
};

export async function weightedRateLimit(
  userId: string,
  operation: keyof typeof OPERATION_COSTS,
) {
  const cost = OPERATION_COSTS[operation];
  const quota = 100; // 100 "points" per minute
  
  return checkLimit(
    `weighted:${userId}`,
    quota,
    60,
  );
}
```

## HTTP Response Headers

The service automatically sets standard rate limit headers:

```
HTTP/1.1 200 OK
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1700000060
Content-Type: application/json
```

Clients can use these headers to:
- Display remaining quota to users
- Implement client-side rate limiting
- Optimize request pacing

## Error Responses

### Standard 429 Response

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Please try again later.",
  "reset_at": 1700000060,
  "retry_after": 30
}
```

### Custom Response (Per-Endpoint)

```typescript
if (!result.allowed) {
  res.status(429).json({
    error: 'Rate Limited',
    details: {
      endpoint: '/api/expensive-operation',
      limit: 10,
      window_seconds: 60,
      reset_at: result.reset_at,
      wait_seconds: result.reset_at - Math.floor(Date.now() / 1000),
    },
  });
}
```

## Testing

### Unit Tests

```typescript
// tests/services/rateLimiting.service.test.ts
// (Already included - 21 tests)
```

### Integration Tests

```typescript
// tests/integration/rateLimiting.integration.test.ts
import request from 'supertest';
import app from '../../src/index';

describe('Rate Limiting Integration', () => {
  it('should enforce rate limits on API endpoints', async () => {
    const userId = 'test-user-123';
    
    // Make 61 requests (exceeds 60/min limit)
    for (let i = 0; i < 61; i++) {
      const res = await request(app)
        .get('/api/markets')
        .set('X-User-ID', userId);
      
      if (i < 60) {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(429);
        expect(res.body.error).toBe('Too Many Requests');
      }
    }
  });
});
```

## Monitoring

### Prometheus Metrics (Future Enhancement)

```typescript
// Track rate limit events
const rateLimitExceeded = new Counter({
  name: 'rate_limit_exceeded_total',
  help: 'Total requests rejected due to rate limiting',
  labelNames: ['tier', 'endpoint'],
});

const rateLimitRemaining = new Gauge({
  name: 'rate_limit_remaining',
  help: 'Remaining quota for rate limited requests',
  labelNames: ['tier'],
});
```

### Logging

```typescript
// All rate limit events are logged
logger.debug({ key, remaining }, 'Request allowed');
logger.warn({ key, remaining, reset_at }, 'Request rejected');
logger.error({ err, key }, 'Rate limit service error');
```

## Troubleshooting

### "Rate limit exceeded" immediately

```typescript
// Check current count
const count = await getCurrentCount(userId);
console.log(`Current count: ${count}`);

// Reset if needed
await resetLimit(userId);
```

### Headers not appearing

```typescript
// Verify middleware is applied
app.use('/api/', rateLimitingMiddleware()); // Must come before routes
```

### Redis connection failed

```typescript
// Service fails open (allows requests)
// Check Redis logs and connection:
docker logs redis-test
docker exec redis-test redis-cli ping
```

## Best Practices

1. **Apply middleware globally** for consistent rate limiting
2. **Use tiers** for different user classes
3. **Set per-endpoint limits** for expensive operations
4. **Log rate limit events** for monitoring
5. **Educate users** on rate limits in documentation
6. **Provide reset mechanism** for support operations
7. **Monitor metrics** for rate limit policy adjustments

---

**Version**: 1.0
**Last Updated**: 2024-11-24
