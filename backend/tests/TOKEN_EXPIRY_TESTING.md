# Token Expiry Testing Guide

## Overview

Token expiry bugs are critical security vulnerabilities that can only be caught with time-based testing. This guide covers the comprehensive token expiry test suite added to `auth.service.test.ts`.

## Why Time-Based Testing Matters

Without proper token expiry tests, several production failures can occur:

- **Expired access tokens** accepted beyond their TTL (15 minutes)
- **Expired refresh tokens** allowing session hijacking beyond 7 days
- **Expired reset tokens** allowing unlimited password resets
- **Race conditions** where tokens expire between validation and use

## Using jest.useFakeTimers()

### Setup
```typescript
beforeEach(() => {
  jest.useFakeTimers();  // Use fake system time
});

afterEach(() => {
  jest.useRealTimers();  // Restore real time
});
```

### Advancing Time
```typescript
const now = Date.now();
jest.setSystemTime(now);
jest.advanceTimersByTime(15 * 60 * 1000);  // Advance 15 minutes
```

## Test Cases Implemented

### 1. Access Token Expiry (15 minutes)
```typescript
it('should reject expired access token with 401', async () => {
  // Create token valid for 15 minutes
  // Advance 16 minutes
  // Expect TokenExpiredError
});
```

**Why this matters:** Access tokens protect API endpoints. If expired tokens aren't rejected, attackers could reuse stolen tokens indefinitely.

### 2. Refresh Token Expiry (7 days)
```typescript
it('should reject expired refresh token and require re-login', async () => {
  // Create token valid for 7 days
  // Advance 8 days
  // Expect TokenExpiredError
});
```

**Why this matters:** Refresh tokens have longer TTLs. If not properly expired, sessions become effectively permanent.

### 3. Password Reset Token Expiry (1 hour)
```typescript
it('should reject expired password reset token', async () => {
  // Create token valid for 1 hour
  // Advance 65 minutes
  // Expect TokenExpiredError
});
```

**Why this matters:** Reset tokens must expire quickly to limit account takeover windows. A 1-hour window is standard.

### 4. Valid Token Before Expiry
```typescript
it('should accept access token before expiry', async () => {
  // Create token valid for 15 minutes
  // Advance 10 minutes
  // Expect verification succeeds
});
```

**Why this matters:** Ensures we don't reject valid tokens. Critical for normal functionality.

### 5. Refresh Flow with Valid Token
```typescript
it('should successfully refresh tokens with valid refresh token', async () => {
  // Advance 3 days (within 7-day TTL)
  // Verify can generate new access token
});
```

**Why this matters:** The refresh flow is the legitimate way to extend sessions. Must work throughout the refresh token's TTL.

### 6. Multiple Token Expiries
```typescript
it('should handle multiple tokens with different expiry times', async () => {
  // At 10 minutes: both access and refresh valid
  // At 20 minutes: access expired, refresh still valid
  // Expect proper behavior at each stage
});
```

**Why this matters:** In practice, users have multiple tokens in flight. They must each respect their own expiry time.

### 7. Email Verification Token Expiry (15 minutes)
```typescript
it('should reject expired email verification token', async () => {
  // Create token valid for 15 minutes
  // Advance 20 minutes
  // Expect TokenExpiredError
});
```

**Why this matters:** Email verification links should expire to prevent brute-force attacks on signup.

## Token Type Reference

| Token Type | TTL | Use Case |
|-----------|-----|----------|
| `access` | 15 minutes | API authentication |
| `refresh` | 7 days | Session refresh |
| `password_reset` | 1 hour | Password reset flow |
| `email_verification` | 15 minutes | Email verification |
| `temp_2fa` | 10 minutes | 2FA challenge |

## Running the Tests

```bash
cd backend
npm test -- tests/services/auth.service.test.ts

# Run only token expiry tests
npm test -- tests/services/auth.service.test.ts -t "Token expiry"
```

## Expected Output

All 7 token expiry tests should pass:
```
Token expiry and refresh
  ✓ should reject expired access token with 401
  ✓ should reject expired refresh token and require re-login
  ✓ should reject expired password reset token
  ✓ should accept access token before expiry
  ✓ should successfully refresh tokens with valid refresh token
  ✓ should handle multiple tokens with different expiry times
  ✓ should reject expired email verification token
```

## Debugging Expired Token Failures

If tests fail, check:

1. **Token expiry time in code**: Ensure `expiresIn` matches test expectations
   ```typescript
   jwt.sign(payload, secret, { expiresIn: '15m' })  // Must be 15m
   ```

2. **Time advancement calculation**: Milliseconds vs seconds
   ```typescript
   15 * 60 * 1000  // 15 minutes in milliseconds
   Math.floor(Date.now() / 1000) + 15 * 60  // 15 minutes in Unix seconds
   ```

3. **Mock state**: Ensure `jest.clearAllMocks()` runs in `afterEach()`

4. **Timezone issues**: Test uses `Math.floor(now / 1000)` for Unix timestamps (UTC-based)

## Integration with CI/CD

These tests run on every push to `backend/`:
- GitHub Actions → backend-ci.yml → npm test
- Ensures token expiry bugs are caught before production
- Part of the pre-merge validation

## Adding New Token Types

When adding a new token type with its own expiry time:

1. Add an expiry test in this suite
2. Update the token type reference table above
3. Add test case following the pattern:
   ```typescript
   it('should reject expired [token_type] token', async () => {
     const now = Date.now();
     jest.setSystemTime(now);
     
     const payload = {
       sub: 'user-expiry-test',
       type: '[token_type]',
       exp: Math.floor(now / 1000) + [TTL_IN_SECONDS],
     };
     
     mockJwt.verify.mockReturnValue(payload as never);
     jest.advanceTimersByTime([TTL_PLUS_1_IN_MS]);
     
     mockJwt.verify.mockImplementation(() => {
       const err = new Error('jwt expired');
       (err as any).name = 'TokenExpiredError';
       throw err;
     });
     
     expect(() => jwt.verify('token', secret)).toThrow();
   });
   ```

## References

- [Jest Fake Timers Documentation](https://jestjs.io/docs/timer-mocks)
- [JWT Token Expiry Best Practices](https://tools.ietf.org/html/rfc7519#section-4.1.4)
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
