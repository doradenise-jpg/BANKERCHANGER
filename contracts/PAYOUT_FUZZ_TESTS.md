# Payout Math Fuzz Testing Guide

## Overview

The `payout_math_fuzz_tests` module uses **proptest** to perform property-based testing on the parimutuel payout calculation. This ensures that the contract's math is safe across the full range of i128 values, preventing overflow/underflow panics on mainnet.

## Problem Addressed

Previous unit tests only covered small, hand-crafted inputs like:
- pool_a = 10_000_000 (0.001 XLM)
- pool_b = 5_000_000
- total_pool = 15_000_000

These fail to exercise:
- **Overflow conditions**: What happens when total_pool approaches i128::MAX?
- **Division by zero**: What if a pool is empty?
- **Underflow**: Can pools become negative?
- **Fee precision**: Does 2% fee calculation overflow with large pools?
- **Payout precision**: Do multiple payouts sum to > net_pool (overpayment)?

## Fuzz Testing Properties

### 1. Fee Calculation Never Overflows
```rust
fn prop_fee_calc_no_overflow(total_pool: i128, fee_bps: i128) -> bool
```

**Property**: For any `total_pool` and `fee_bps` in valid ranges:
- `fee = total_pool * fee_bps / 10_000` must not panic
- `fee ≤ total_pool` (no overpayment to treasury)

**Tested values**:
- `total_pool`: 0 to i128::MAX / 2
- `fee_bps`: 0 to 10_000 (100%)

**Example failure caught**: 
```
total_pool = 9_223_372_036_854_775_807 (i128::MAX / 2)
fee_bps = 10_000
fee = 9_223_372_036_854_775_807 * 10_000 / 10_000 = 9_223_372_036_854_775_807 ✓
(no overflow)
```

### 2. Payout Calculation Never Overflows
```rust
fn prop_payout_calc_no_overflow(bettor_stake: i128, winning_pool: i128, fee_bps: i128) -> bool
```

**Property**: For any bettor stake, winning pool, and fee:
- `payout = bettor_stake * net_pool / winning_pool` must not panic
- `payout ≤ net_pool` (no overpayment)

**Tested values**:
- `bettor_stake`: 0 to i128::MAX / 3
- `winning_pool`: 1 to i128::MAX / 3
- `fee_bps`: 1 to 10_000

### 3. Pools Always Non-Negative
```rust
fn prop_pools_always_non_negative(pool_a: i128, pool_b: i128, pool_draw: i128) -> bool
```

**Property**: Pool accumulation must never go negative:
- `total_pool = pool_a + pool_b + pool_draw ≥ 0`

**Tested values**:
- Each pool: 0 to i128::MAX / 3 (ensures sum ≤ i128::MAX)

### 4. Fee Never Exceeds Total
```rust
fn prop_fee_never_exceeds_total(total_pool: i128, fee_bps: i128) -> bool
```

**Property**: Treasury extraction limit:
- `fee ≤ total_pool` always

This is a core invariant: if violated, the treasury could drain the entire pool.

### 5. Payout + Fee ≤ Total Pool
```rust
fn prop_payout_plus_fee_not_exceed_total(
    bettor_stakes: Vec<i128>,
    fee_bps: i128,
    losing_pool: i128
) -> bool
```

**Property**: All winners' payouts plus treasury fee cannot exceed the total pool:
- `sum(payouts) + fee ≤ total_pool`

This prevents the contract from paying out more XLM than was deposited.

**Tested values**:
- `bettor_stakes`: Vec of 0-10 random stakes
- `fee_bps`: 1 to 10_000
- `losing_pool`: 0 to i128::MAX / 4

### 6. Floor Division Prevents Overpayment
```rust
fn prop_floor_division_prevents_overpayment(a: i128, b: i128, c: i128) -> bool
```

**Property**: Integer division (floor) ensures no rounding-up overpayments:
- `payout = a * b / c` (integer division)
- For 3 equal bettors: `sum(payouts) ≤ 3 * single_payout ≤ net_pool`

This verifies that using integer (floor) division instead of floating-point never causes overpayment.

## Running the Fuzz Tests

### Run All Payout Fuzz Tests
```bash
cd contracts
cargo test payout_math_fuzz_tests --lib -- --nocapture
```

### Run Specific Property
```bash
cargo test fuzz_fee_calculation_no_overflow --lib -- --nocapture
cargo test fuzz_payout_calculation_no_overflow --lib -- --nocapture
```

### Increase Fuzz Iterations (More Thorough)
```bash
PROPTEST_CASES=10000 cargo test payout_math_fuzz_tests --lib
```

Default is 256 random test cases per property. 10,000 is more thorough for CI.

### See Failing Test Case Details
```bash
PROPTEST_VERBOSE=1 cargo test fuzz_fee_calculation_no_overflow --lib
```

## Boundary Case Tests

Beyond the fuzz tests, manual boundary tests cover extreme scenarios:

### 1. i128::MAX Pool Edge Case
```rust
#[test]
fn test_pool_near_i128_max_no_panic()
```

- **Pool**: i128::MAX / 2 = ~4.6 quintillion stroops
- **Verifies**: Saturating arithmetic prevents panic

### 2. Maximum Total, Minimum Winning Pool
```rust
#[test]
fn test_payout_max_total_min_winning_pool()
```

- **Setup**: total_pool = i128::MAX / 2, winning_pool = 1
- **Worst case**: Division by 1 → maximum payout
- **Verifies**: Saturating multiplication prevents panic

### 3. Fee Boundary Cases (0%, 2%, 100%)
```rust
#[test]
fn test_fee_boundary_cases()
```

- **fee_bps = 0**: No fee → net_pool = total_pool
- **fee_bps = 200**: Standard 2% fee
- **fee_bps = 10_000**: 100% fee (extreme)

### 4. Three Equal Bettors
```rust
#[test]
fn test_three_equal_bettors_no_overpayment()
```

- **Scenario**: 3 bettors with equal stakes on winning side
- **Verifies**: Total payout ≤ net_pool (no overpayment)

### 5. Saturating Arithmetic
```rust
#[test]
fn test_saturating_arithmetic_prevents_panic()
```

- **Input**: a = i128::MAX, b = i128::MAX
- **Call**: `a.saturating_mul(b)`
- **Verifies**: Result clamps to i128::MAX, doesn't panic

## CI/CD Integration

These tests run on every commit to `contracts/`:

```yaml
# .github/workflows/contracts-ci.yml
- name: Fuzz tests
  working-directory: contracts
  run: |
    PROPTEST_CASES=1000 cargo test payout_math_fuzz_tests --lib
```

## Failure Scenarios (What We Catch)

### Unchecked Multiplication
```rust
// WRONG: This panics with large pools
let payout = bettor_stake * net_pool / winning_pool;

// RIGHT: Saturating prevents panic
let payout = bettor_stake.saturating_mul(net_pool) / winning_pool;
```

### Unchecked Addition
```rust
// WRONG: Panics if total_pool + new_bet > i128::MAX
total_pool += new_bet;

// RIGHT: Use saturating_add
total_pool = total_pool.saturating_add(new_bet);
```

### Division by Zero
```rust
// WRONG: Panics if winning_pool == 0
payout = stake * net_pool / winning_pool;

// RIGHT: Fuzz tests ensure winning_pool ≥ 1
// In production, require: if winning_pool == 0, return 0
```

### Signed Integer Underflow
```rust
// WRONG: Can go negative if fee > total_pool
let net_pool = total_pool - fee;

// RIGHT: Use saturating_sub
let net_pool = total_pool.saturating_sub(fee);
// But also: verify fee ≤ total_pool in tests
```

## Architecture

```
tests.rs (3400+ lines)
  ├── security_tests (baseline invariants)
  ├── place_bet_edge_cases (bet validation)
  ├── claim_winnings_payout_math (small inputs)
  ├── get_current_odds_tests (odds calculation)
  ├── estimate_payout_tests (hypothetical payouts)
  └── payout_math_fuzz_tests (NEW: large random inputs)
      ├── fuzz_fee_calculation_no_overflow (proptest)
      ├── fuzz_payout_calculation_no_overflow (proptest)
      ├── fuzz_pools_never_negative (proptest)
      ├── fuzz_fee_never_exceeds_total (proptest)
      ├── fuzz_payout_plus_fee_not_exceed_total (proptest)
      ├── fuzz_floor_division_prevents_overpayment (proptest)
      └── Boundary case tests (manual extremes)
```

## References

- [proptest Documentation](https://docs.rs/proptest/latest/proptest/)
- [Rust Saturating Arithmetic](https://doc.rust-lang.org/std/primitive.i128.html#method.saturating_mul)
- [Soroban SDK Integer Types](https://developers.stellar.org/docs/learn/encyclopedia/sc-environment/types#integer-types)
- [OWASP: Integer Overflow](https://owasp.org/www-community/attacks/Integer_Overflow)

## Maintenance

When adding new payout-related functions:

1. Add unit tests with small, known values
2. Add proptest properties for randomized inputs
3. Add boundary case tests for i128 edges
4. Document the invariants being verified
5. Run fuzz tests locally before committing:
   ```bash
   PROPTEST_CASES=5000 cargo test payout_math_fuzz_tests --lib
   ```

## Example: Adding a New Payout Variant

If you add a "bonus multiplier" feature:

```rust
// New calculation: payout_with_bonus = (stake * net_pool / pool) * (100 + bonus_bps) / 100
// Add property:
fn prop_bonus_multiplier_no_overflow(
    stake: i128,
    net_pool: i128,
    pool: i128,
    bonus_bps: i128
) -> bool {
    let payout = stake.saturating_mul(net_pool) / pool.max(1);
    let multiplier = (100i128 + bonus_bps).max(100);
    let boosted = payout.saturating_mul(multiplier) / 100;
    boosted <= net_pool.saturating_mul(2)  // Bonus ≤ 1x boost
}

// Add to proptest!
proptest! {
    #[test]
    fn fuzz_bonus_multiplier_no_overflow(
        stake in 0i128..i128::MAX / 3,
        net_pool in 0i128..i128::MAX / 3,
        pool in 1i128..i128::MAX / 3,
        bonus_bps in 0i128..1000i128
    ) {
        prop_assert!(prop_bonus_multiplier_no_overflow(stake, net_pool, pool, bonus_bps));
    }
}
```

This ensures the new feature won't overflow on mainnet.
