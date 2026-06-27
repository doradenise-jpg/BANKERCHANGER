# API Error Codes

This document describes all machine-readable error codes returned by the BANKERCHANGER API. Error codes enable robust, programmatic error handling in client applications without relying on error message strings.

## Error Response Format

All API errors are returned in the following format:

```json
{
  "error": {
    "statusCode": 400,
    "message": "Human-readable error description",
    "code": "ERROR_CODE"
  }
}
```

The `code` field contains the machine-readable error identifier that can be used for conditional logic in client applications.

## Error Codes by Category

### Validation Errors (4xx)

| Code | Status | Description |
|------|--------|-------------|
| `INVALID_REQUEST` | 400 | The request body is invalid or missing required fields |
| `INVALID_MARKET_ID` | 400 | The provided market ID is invalid or not a number |
| `INVALID_BET_AMOUNT` | 400 | The bet amount is invalid (must be a positive number) |
| `INVALID_BET_SIDE` | 400 | The bet side is invalid (must be FIGHTER_A, FIGHTER_B, or DRAW) |
| `INSUFFICIENT_BALANCE` | 400 | User has insufficient balance for this operation |

### Market State Errors (4xx)

| Code | Status | Description |
|------|--------|-------------|
| `MARKET_NOT_FOUND` | 404 | The market with the given ID does not exist |
| `MARKET_LOCKED` | 409 | The market is currently locked and does not accept new bets |
| `MARKET_RESOLVED` | 409 | The market has been resolved and no longer accepts bets |
| `MARKET_DISPUTED` | 409 | The market outcome is being disputed and awaiting admin resolution |

### Betting Errors (4xx)

| Code | Status | Description |
|------|--------|-------------|
| `BET_BELOW_MINIMUM` | 400 | The bet amount is below the market minimum |
| `BET_ABOVE_MAXIMUM` | 400 | The bet amount exceeds the market maximum |
| `BET_WINDOW_CLOSED` | 409 | Betting window has closed for this market |

### Claim/Withdrawal Errors (4xx)

| Code | Status | Description |
|------|--------|-------------|
| `NO_WINNINGS_TO_CLAIM` | 400 | User has no winnings to claim in this market |
| `ALREADY_CLAIMED` | 409 | User has already claimed winnings from this market |
| `WITHDRAWAL_LIMIT_EXCEEDED` | 429 | Daily withdrawal limit has been exceeded |
| `CLAIM_FAILED` | 500 | Claim operation failed during execution |

### Authentication & Authorization (4xx)

| Code | Status | Description |
|------|--------|-------------|
| `UNAUTHORIZED` | 401 | User is not authenticated |
| `FORBIDDEN` | 403 | User does not have permission to access this resource |
| `INVALID_CREDENTIALS` | 401 | Provided credentials are invalid |
| `TOKEN_EXPIRED` | 401 | Authentication token has expired |

### Admin/Oracle Errors (4xx)

| Code | Status | Description |
|------|--------|-------------|
| `ADMIN_ONLY` | 403 | This operation requires admin privileges |
| `ORACLE_ONLY` | 403 | This operation can only be performed by an oracle |
| `ORACLE_CONSENSUS_FAILED` | 409 | Oracle consensus not reached for market resolution |

### Resource Errors (4xx)

| Code | Status | Description |
|------|--------|-------------|
| `NOT_FOUND` | 404 | The requested resource was not found |
| `RESOURCE_ALREADY_EXISTS` | 409 | A resource with this identifier already exists |

### Server Errors (5xx)

| Code | Status | Description |
|------|--------|-------------|
| `DATABASE_ERROR` | 500 | A database operation failed |
| `TRANSACTION_FAILED` | 500 | Database transaction failed |
| `CONTRACT_EXECUTION_FAILED` | 500 | Smart contract execution failed |
| `TRANSACTION_FAILED_ON_CHAIN` | 500 | Transaction failed on the blockchain |
| `INSUFFICIENT_STELLAR_BALANCE` | 500 | Insufficient XLM balance to complete transaction |
| `INTERNAL_ERROR` | 500 | An internal server error occurred |
| `SERVICE_UNAVAILABLE` | 503 | Service is temporarily unavailable |
| `REQUEST_TIMEOUT` | 504 | Request processing timed out |

## Client Usage Examples

### JavaScript/TypeScript

```typescript
import axios from 'axios';

try {
  const response = await axios.post('/api/markets/1/bets', {
    amount: 1000,
    side: 'FIGHTER_A'
  });
} catch (error) {
  if (error.response?.data?.error?.code === 'MARKET_LOCKED') {
    console.log('Market is locked, cannot place new bets');
  } else if (error.response?.data?.error?.code === 'BET_BELOW_MINIMUM') {
    console.log('Bet amount is below minimum');
  } else {
    console.log('Unknown error:', error.message);
  }
}
```

### React with Error Handling

```typescript
function PlaceBetForm() {
  const [error, setError] = useState<string | null>(null);

  const handleBet = async (amount: number, side: BetSide) => {
    try {
      await api.placeBet({ amount, side });
    } catch (err: any) {
      const errorCode = err.response?.data?.error?.code;

      switch (errorCode) {
        case 'MARKET_LOCKED':
          setError('Betting window has closed');
          break;
        case 'BET_BELOW_MINIMUM':
          setError('Minimum bet amount is required');
          break;
        case 'INSUFFICIENT_BALANCE':
          setError('Insufficient balance to place this bet');
          break;
        default:
          setError(err.response?.data?.error?.message || 'An error occurred');
      }
    }
  };

  return (
    <>
      {error && <div className="error">{error}</div>}
      {/* form content */}
    </>
  );
}
```

## Adding New Error Codes

When adding new error codes:

1. Add the error code constant to `src/constants/errorCodes.ts`
2. Add the description to `ERROR_CODE_DESCRIPTIONS`
3. Update this documentation
4. Update the OpenAPI specification
5. Use the code when throwing AppError in backend

Example:

```typescript
import { AppError } from './utils/AppError';
import { ERROR_CODES } from './constants/errorCodes';

throw AppError.badRequest(
  'Bet amount is below minimum',
  ERROR_CODES.BET_BELOW_MINIMUM
);
```
