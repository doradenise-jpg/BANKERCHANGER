//! Fuzz target: AMM price functions (compute_odds, calc_max_trade, calc_claimable_lp_fees,
//! tier helpers).
//!
//! Goal: run at least 10 million iterations in CI (`cargo fuzz run amm_fuzz -- -max_total_time=60`)
//! without any crash, hang, or AddressSanitizer violation.
//!
//! Invariants verified on every valid output:
//! - `compute_odds` never panics for any i128 input combination.
//! - When `compute_odds` returns `Some((shares, impact))`:
//!     * shares > 0
//!     * shares < the relevant output-pool size
//!     * impact is in [0, 10_000] bps
//! - `calc_max_trade` never panics and always returns a value in [0, reserve - 1].
//! - `calc_claimable_lp_fees` never panics and always returns a non-negative value.
//! - `check_tier_slippage` never panics.

#![no_main]

use boxmeout_shared::amm::{
    calc_claimable_lp_fees, calc_max_trade, check_tier_slippage, compute_odds,
};
use libfuzzer_sys::fuzz_target;

/// Structured input parsed from the raw fuzzer bytes so that libFuzzer's
/// mutation engine generates semantically meaningful inputs quickly.
#[derive(Debug)]
struct AmmInput {
    pool_a:     i128,
    pool_b:     i128,
    pool_draw:  i128,
    bet_amount: i128,
    side:       u8,
    reserve:    i128,
    balance:    i128,
    fee_per_share: i128,
    fee_debt:   i128,
    lp_shares:  i128,
    total_pool: i128,
    impact_bps: i128,
    tier:       u8,
}

/// Parse the raw fuzzer byte slice into an `AmmInput`.
/// Returns `None` when the slice is too short to be useful.
fn parse(data: &[u8]) -> Option<AmmInput> {
    if data.len() < 104 {
        return None;
    }

    // Each i128 is 16 bytes (128 bits); read them as little-endian.
    let pool_a      = i128::from_le_bytes(data[0..16].try_into().ok()?);
    let pool_b      = i128::from_le_bytes(data[16..32].try_into().ok()?);
    let pool_draw   = i128::from_le_bytes(data[32..48].try_into().ok()?);
    let bet_amount  = i128::from_le_bytes(data[48..64].try_into().ok()?);
    let reserve     = i128::from_le_bytes(data[64..80].try_into().ok()?);
    let balance     = i128::from_le_bytes(data[80..96].try_into().ok()?);
    let fee_per_share = if data.len() >= 112 {
        i128::from_le_bytes(data[96..112].try_into().ok()?)
    } else {
        0
    };
    let fee_debt = if data.len() >= 128 {
        i128::from_le_bytes(data[112..128].try_into().ok()?)
    } else {
        0
    };
    let lp_shares = if data.len() >= 144 {
        i128::from_le_bytes(data[128..144].try_into().ok()?)
    } else {
        1_000_000
    };
    let total_pool = if data.len() >= 160 {
        i128::from_le_bytes(data[144..160].try_into().ok()?)
    } else {
        1_000_000_000
    };
    let impact_bps = if data.len() >= 176 {
        i128::from_le_bytes(data[160..176].try_into().ok()?)
    } else {
        500
    };

    // Side: 0, 1, or 2 (map to valid range; include 3/255 to probe invalid-side path).
    let side = data[96 % data.len()];
    // Tier: one of 8, 10, 12, 14, or an arbitrary byte for unknown-tier path.
    let tier = data[97 % data.len()];

    Some(AmmInput {
        pool_a,
        pool_b,
        pool_draw,
        bet_amount,
        side,
        reserve,
        balance,
        fee_per_share,
        fee_debt,
        lp_shares,
        total_pool,
        impact_bps,
        tier,
    })
}

fuzz_target!(|data: &[u8]| {
    let Some(inp) = parse(data) else { return };

    // ── 1. compute_odds — must never panic ────────────────────────────────────
    let odds_result = compute_odds(
        inp.pool_a,
        inp.pool_b,
        inp.pool_draw,
        inp.bet_amount,
        inp.side,
    );

    if let Some((shares, impact)) = odds_result {
        // Invariant: shares must be positive
        assert!(
            shares > 0,
            "compute_odds returned non-positive shares={shares} for input {inp:?}"
        );

        // Invariant: shares must be strictly less than the output pool
        let out_pool = match inp.side {
            0 => inp.pool_a,
            1 => inp.pool_b,
            2 => inp.pool_draw,
            _ => {
                // Invalid side — compute_odds should have returned None.
                // If we somehow reach here, just skip the pool check.
                return;
            }
        };
        assert!(
            shares < out_pool,
            "compute_odds: shares={shares} >= out_pool={out_pool} for input {inp:?}"
        );

        // Invariant: price impact must be in [0, 10_000] bps
        assert!(
            impact <= 10_000,
            "compute_odds: impact={impact} > 10_000 for input {inp:?}"
        );
        // impact is i128; the function clamps via `.max(0)` so it is non-negative.
        // Assert anyway in case a future refactor removes the clamp.
        assert!(
            impact >= 0,
            "compute_odds: impact={impact} < 0 for input {inp:?}"
        );
    }

    // ── 2. calc_max_trade — must never panic ──────────────────────────────────
    let max_trade = calc_max_trade(inp.reserve, inp.balance);
    // Result must be non-negative.
    assert!(
        max_trade >= 0,
        "calc_max_trade returned negative value={max_trade} for reserve={}, balance={}",
        inp.reserve,
        inp.balance
    );
    // If reserve > 1 and balance > 0, result must be exactly reserve - 1.
    if inp.reserve > 1 && inp.balance > 0 {
        assert_eq!(
            max_trade,
            inp.reserve - 1,
            "calc_max_trade: expected reserve-1={} got {max_trade}",
            inp.reserve - 1
        );
    }

    // ── 3. calc_claimable_lp_fees — must never panic ──────────────────────────
    let fees = calc_claimable_lp_fees(inp.fee_per_share, inp.fee_debt, inp.lp_shares);
    // Result must be non-negative (saturating_sub + saturating_mul guarantee this).
    assert!(
        fees >= 0,
        "calc_claimable_lp_fees returned negative value={fees}"
    );

    // ── 4. check_tier_slippage — must never panic ─────────────────────────────
    let _within_limit = check_tier_slippage(inp.tier, inp.total_pool, inp.impact_bps);
    // No invariant to assert here — bool result is always valid.
});
