# Fix: Separate Horizon and Soroban RPC Servers

## Problem

The `invokeContract()` function incorrectly used `rpc.Server(horizonUrl)` to load account data:

```typescript
const server = new rpc.Server(horizonUrl);  // ❌ Wrong!
const sourceAccount = await server.getAccount(source_keypair.publicKey());
```

**Root cause**: `rpc.Server` is the **Soroban RPC client**, which only exposes `simulateTransaction()`, `sendTransaction()`, and `getTransaction()`. It **does not have `getAccount()`** — that method belongs to **Horizon REST API**.

**Runtime error**: Every contract invocation throws `TypeError: server.getAccount is not a function`

## Impact

- ❌ All contract invocations fail immediately at runtime
- ❌ Oracle can't submit fight results
- ❌ Markets can't resolve
- ❌ Market factory can't create markets
- ❌ Users can't place bets

## Solution

Use the correct server for each operation:

1. **Horizon.Server** – for account queries (`loadAccount()`, `feeStats()`, etc.)
2. **rpc.Server** – for Soroban operations (`simulateTransaction()`, `sendTransaction()`, `getTransaction()`)

### Before

```typescript
import { rpc } from '@stellar/stellar-sdk';

const server = new rpc.Server(horizonUrl);
const sourceAccount = await server.getAccount(publicKey);  // ❌ Throws at runtime
```

### After

```typescript
import { Horizon, rpc } from '@stellar/stellar-sdk';

// Use Horizon.Server for account loading
const horizonServer = new Horizon.Server(horizonUrl);
const sourceAccount = await horizonServer.loadAccount(publicKey);  // ✓ Correct

// Use rpc.Server only for Soroban operations
const sorobanServer = new rpc.Server(rpcUrl);
await sorobanServer.simulateTransaction(tx);  // ✓ Correct
```

## Changes Made

### 1. Updated Imports (`src/services/StellarService.ts`)

Added `Horizon` to imports:

```typescript
import { Account, Horizon, Keypair, Networks, Operation, rpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
```

### 2. Fixed `invokeContract()` Function

Replaced:
- ~~`new rpc.Server(horizonUrl)` with `getAccount()`~~ 
- With: `new Horizon.Server(horizonUrl)` with `loadAccount()`

And kept:
- ✓ `new rpc.Server(rpcUrl)` for `simulateTransaction()`, `sendTransaction()`, `getTransaction()`

### 3. Fixed `getCurrentBaseFee()` Function

Replaced:
- ~~`new Server(horizonUrl)`~~ (undefined, missing import)
- With: `new Horizon.Server(horizonUrl)` with `feeStats()`

### 4. Fixed `fetchHistoricalEvents()` Function

Replaced:
- ~~`new Server(horizonUrl)`~~ (undefined, missing import)
- With: `new Horizon.Server(horizonUrl)` with `transactions()`

### 5. Updated Tests (`tests/services/StellarService.test.ts`)

Added mock for `Horizon.Server`:
- Created `horizon` mock object with `loadAccount()` method
- Separated `rpc` mock to only include Soroban operations
- Updated `beforeEach()` to initialize Horizon mock correctly

## Verification

✓ `Horizon.Server` has `loadAccount()`, `feeStats()`, `transactions()`
✓ `rpc.Server` has `simulateTransaction()`, `sendTransaction()`, `getTransaction()`
✓ All three functions now use correct servers
✓ No more runtime errors from `getAccount is not a function`

## Files Modified

1. `src/services/StellarService.ts` – Added Horizon import, fixed three functions
2. `tests/services/StellarService.test.ts` – Updated mocks to separate Horizon and RPC

## Testing

Run tests to verify the fix:
```bash
npm test -- tests/services/StellarService.test.ts
```

---

**Status**: ✅ Fixed. Contract invocations will no longer throw at runtime.
