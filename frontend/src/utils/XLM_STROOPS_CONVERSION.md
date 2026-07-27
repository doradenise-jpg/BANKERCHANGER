# XLM to Stroops Conversion Utility

## Overview

The `xlmToStroops` and `stroopsToXlm` functions provide safe, precise conversion between XLM (Stellar Lumens) and stroops (the smallest unit).

- **1 XLM = 10,000,000 stroops**
- **1 stroop = 0.0000001 XLM** (7 decimal places)

## Functions

### `xlmToStroops(xlm: number): bigint`

Converts an XLM amount to stroops with proper handling of decimals and edge cases.

**Features**:
- ✓ Handles integers and decimals
- ✓ Handles scientific notation (e.g., `1e-7`)
- ✓ **Truncates** decimals beyond 7 places (no rounding)
- ✓ Validates input (rejects NaN, Infinity, negative values)
- ✓ Returns BigInt for precision

**Examples**:
```typescript
xlmToStroops(1)              // 10000000n
xlmToStroops(0.1)            // 1000000n
xlmToStroops(0.1234567)      // 1234567n (exactly 7 decimals)
xlmToStroops(0.12345678)     // 1234567n (truncates 8th decimal)
xlmToStroops(1e-7)           // 1n
xlmToStroops(0)              // 0n
```

**Truncation Behavior** (not rounding):
```typescript
xlmToStroops(0.99999999)     // 9999999n (not 10000000n)
xlmToStroops(0.12345675)     // 1234567n (not 1234568n)
```

**Error Cases**:
```typescript
xlmToStroops(NaN)            // throws Error
xlmToStroops(Infinity)       // throws Error
xlmToStroops(-1)             // throws Error
```

### `stroopsToXlm(stroops: bigint | number): number`

Converts stroops back to XLM.

**Examples**:
```typescript
stroopsToXlm(10_000_000n)    // 1
stroopsToXlm(1_000_000n)     // 0.1
stroopsToXlm(1n)             // 0.0000001
stroopsToXlm(1_234_567n)     // 0.1234567
```

## Usage Patterns

### In React Components

```typescript
import { xlmToStroops } from '@/utils/xlmToStroops';

function BetForm() {
  const handleSubmit = (xlmAmount: number) => {
    const stroops = xlmToStroops(xlmAmount);
    // Send stroops to contract
    submitBet(stroops);
  };
}
```

### In API Calls

```typescript
// User inputs bet: "5.5" XLM
const userInput = parseFloat(form.values.betAmount);
const stroops = xlmToStroops(userInput);
const response = await api.placeBet({ amount_stroops: stroops });
```

### Round-Trip Conversions

```typescript
// Convert user input to stroops, then back for display
const userXlm = 1.234567;
const stroops = xlmToStroops(userXlm);
const displayXlm = stroopsToXlm(stroops);
console.log(displayXlm); // 1.234567
```

## Design Decisions

### Why Truncate Instead of Round?

The Stellar protocol uses exact stroops (integers). Rounding could cause:
- **Overpayment**: User bets 0.12345675, rounds to 1.2345568 stroops instead of 0.1234567
- **Confusion**: Round and truncate produce different results for the same input

**Solution**: Truncate at 7 decimals (the stroop boundary). Any input with more than 7 decimals loses precision, but the result is predictable and consistent.

Example:
```typescript
// User inputs: "0.12345678" (8 decimals)
// Stored as stroops: 1234567n
// Displayed back as: "0.1234567" (7 decimals)
```

### Why Use BigInt?

JavaScript numbers lose precision at large values:
```typescript
// Without BigInt:
const stroops = 9007199254740992; // Max safe integer, loses precision
const xlm = stroops / 10_000_000; // Floating-point error

// With BigInt:
const stroops = 9007199254740992n; // Exact
const xlm = Number(stroops) / 10_000_000; // Precise up to display
```

### Why Support Scientific Notation?

JavaScript may represent decimals in scientific notation:
```typescript
const num = 0.0000001;
console.log(num.toString()); // "1e-7"
```

The function handles this automatically via `toString()`.

## Testing

Comprehensive test suite covers:

| Scenario | Test Count | Coverage |
|----------|-----------|----------|
| Basic conversions | 5 | 0, 1, 2, 100, 1M XLM |
| Decimals (≤7 places) | 10 | 0.1, 0.01, ..., 0.0000001 XLM |
| Truncation (>7 places) | 6 | Verifies truncation not rounding |
| Scientific notation | 9 | 1e0, 1e-1, ..., 1e6 |
| Edge cases | 6 | NaN, Infinity, negative |
| Precision & rounding | 5 | Truncation behavior verified |
| Real-world scenarios | 6 | Min bet, max bet, typical bets |
| Round-trip conversions | 6 | XLM → stroops → XLM |

Run tests:
```bash
npm test -- xlmToStroops.test.ts
```

## Migration Guide

If you're using the old inline function from `useCreateMarket.ts`:

**Before**:
```typescript
// Inside useCreateMarket.ts
function xlmToStroops(xlm: number): bigint {
  const [whole, frac = ''] = xlm.toString().split('.');
  return BigInt(whole) * BigInt(10_000_000) + BigInt(frac.slice(0, 7).padEnd(7, '0'));
}
```

**After**:
```typescript
import { xlmToStroops } from '@/utils/xlmToStroops';
```

No behavior change—the utility is a drop-in replacement with added error handling and documentation.

## Precision Limits

| Input | Stroops | XLM Display |
|-------|---------|------------|
| 0.0000001 (min) | 1 | 0.0000001 |
| 0.00000001 | 0 | 0 (truncated) |
| 0.1234567 (max 7 decimals) | 1234567 | 0.1234567 |
| 0.12345678 (8 decimals) | 1234567 | 0.1234567 (truncated) |
| 10_000_000 XLM | 100000000000000n | 10000000 |

## Error Messages

```typescript
// NaN
xlmToStroops(NaN)
// throws: "Invalid XLM amount: NaN. Must be a finite number."

// Infinity
xlmToStroops(Infinity)
// throws: "Invalid XLM amount: Infinity. Must be a finite number."

// Negative
xlmToStroops(-1)
// throws: "Invalid XLM amount: -1. Cannot be negative."
```

## Performance

- **Time complexity**: O(1) — Fixed operations regardless of input size
- **Space complexity**: O(1) — Single BigInt allocation
- **No dependencies**: Pure functions, no external libraries

Suitable for frequent conversions in betting UI (no performance concerns).

## Related

- [Stellar Documentation: Stroops](https://developers.stellar.org/docs/reference/keys-limited-trustlines#stroops)
- [useCreateMarket Hook](../hooks/useCreateMarket.ts) — Primary consumer
- [Tests](./\_\_tests\_\_/xlmToStroops.test.ts) — Comprehensive test suite
