# MarketService.getBetsByMarket Implementation

## Overview
Implemented `MarketService.getBetsByMarket(market_id, bettor_address?)` to query bets by market ID with optional bettor address filtering.

## Location
- **File**: `backend/src/services/MarketService.ts`
- **Line**: 767-795 (main function)
- **DbAdapter**: Line 161-173 (findBetsByMarket implementation)

## Acceptance Criteria ✅

### 1. Query bets by market_id (and optional bettor_address)
✅ **IMPLEMENTED**
```typescript
const values: unknown[] = [market_id];
let sql = 'SELECT * FROM bets WHERE market_id = $1';

if (bettor_address) {
  values.push(bettor_address);
  sql += ` AND bettor_address = $${values.length}`;
}
```

### 2. Filters by bettor_address if provided
✅ **IMPLEMENTED**
- When `bettor_address` is provided, adds `AND bettor_address = $2` clause
- Uses parameterized queries to prevent SQL injection

### 3. Returns empty array (not error) if no bets
✅ **IMPLEMENTED**
```typescript
const { rows } = await marketQuery(sql, values);
return rows.map((row) => ({
  ...row,
  placed_at: new Date(row.placed_at),
  claimed_at: row.claimed_at ? new Date(row.claimed_at) : null,
} as Bet));
```
- Maps empty rows array to empty Bet array
- Never throws error for no results

### 4. Sorted by placed_at DESC
✅ **IMPLEMENTED**
```typescript
sql += ' ORDER BY placed_at DESC';
```
- Results always sorted most recent first

### 5. Return type Bet[]
✅ **IMPLEMENTED**
```typescript
export async function getBetsByMarket(
  market_id: string,
  bettor_address?: string,
): Promise<Bet[]>
```

## Tests
Three test cases in `backend/tests/services/market.service.test.ts`:
- **Test 7**: Returns all bets for market when no address filter
- **Test 8**: Returns only matching address bets when filter applied
- **Test 9**: Returns empty array when no bets found

## Usage Example
```typescript
// Get all bets for a market
const bets = await getBetsByMarket('market-123');

// Get bets for specific bettor in a market
const bettorBets = await getBetsByMarket('market-123', 'GABC...xyz');
```

## Error Handling
- Database errors are wrapped in AppError
- SQL errors are logged and returned as 500 Internal Server Error
- No bets found returns empty array (not an error)
