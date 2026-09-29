//! Fuzz target: Parimutuel payout calculation.
//!
//! The payout formula used in `Market::claim_winnings` is:
//!
//! ```text
//! fee      = total_pool * fee_bps / 10_000
//! net_pool = total_pool - fee
//! payout   = bettor_stake * net_pool / winning_pool   (if winning_pool > 0)
//! ```
//!
//! This target re-implements that formula in pure Rust (no Soroban env) using
//! checked arithmetic — exactly as the contract does — and asserts the same
//! invariants that make the payout safe:
//!
//! - Computation never panics (all arithmetic is checked).
//! - `fee` is always in [0, total_pool].
//! - `net_pool` is always in [0, total_pool].
//! - `payout` is always in [0, net_pool] (a bettor can never receive more than
//!   the net pool).
//! - When `winning_pool == total_pool` (everyone bet on the winner) the payout
//!   equals `bettor_stake * net_pool / total_pool` which is at most `net_pool`.
//!
//! Goal: run for at least 10 million iterations in CI without any crash.

#![no_main]

use libfuzzer_sys::fuzz_target;

/// Maximum fee in basis points (100 %).
const MAX_FEE_BPS: i128 = 10_000;

/// Mirrors the checked-arithmetic payout logic in `Market::claim_winnings`.
/// Returns `None` on arithmetic overflow (same as the contract's `ok_or(...)` path).
fn calculate_payout(
    total_pool: i128,
    fee_bps: i128,
    winning_pool: i128,
    bettor_stake: i128,
) -> Option<(i128, i128)> {
    // fee = total_pool * fee_bps / 10_000
    let fee = total_pool
        .checked_mul(fee_bps)?
        .checked_div(10_000)?;

    // net_pool = total_pool - fee
    let net_pool = total_pool.checked_sub(fee)?;

    // payout = bettor_stake * net_pool / winning_pool  (or 0 if winning_pool == 0)
    let payout = if winning_pool > 0 {
        bettor_stake
            .checked_mul(net_pool)?
            .checked_div(winning_pool)?
    } else {
        0
    };

    Some((fee, payout))
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 64 {
        return;
    }

    // Parse four i128 values from the raw bytes.
    let total_pool   = i128::from_le_bytes(data[0..16].try_into().unwrap());
    let fee_bps_raw  = i128::from_le_bytes(data[16..32].try_into().unwrap());
    let winning_pool = i128::from_le_bytes(data[32..48].try_into().unwrap());
    let bettor_stake = i128::from_le_bytes(data[48..64].try_into().unwrap());

    // Clamp fee_bps to [0, 10_000] — the contract stores this as u32 fee_bps
    // so negative / > 10000 values are not reachable, but we fuzz the full range
    // of i128 here to prove the formula handles edge cases safely.
    let fee_bps = fee_bps_raw.abs() % (MAX_FEE_BPS + 1);

    // ── Run payout calculation ────────────────────────────────────────────────
    let result = calculate_payout(total_pool, fee_bps, winning_pool, bettor_stake);

    // ── Invariant checks ──────────────────────────────────────────────────────
    if let Some((fee, payout)) = result {
        // fee must be non-negative
        assert!(
            fee >= 0,
            "fee is negative: fee={fee}, total_pool={total_pool}, fee_bps={fee_bps}"
        );

        // fee must not exceed total_pool
        if total_pool >= 0 {
            assert!(
                fee <= total_pool,
                "fee={fee} > total_pool={total_pool}"
            );
        }

        // net_pool = total_pool - fee must be non-negative when total_pool >= 0
        if total_pool >= 0 {
            let net_pool = total_pool - fee;
            assert!(
                net_pool >= 0,
                "net_pool is negative: net_pool={net_pool}"
            );

            // payout must be non-negative
            assert!(
                payout >= 0,
                "payout is negative: payout={payout}"
            );

            // payout must not exceed net_pool
            // (a single bettor cannot drain more than the entire net prize pool)
            if winning_pool > 0 && bettor_stake >= 0 && bettor_stake <= winning_pool {
                assert!(
                    payout <= net_pool,
                    "payout={payout} > net_pool={net_pool} \
                     (total_pool={total_pool}, fee_bps={fee_bps}, \
                      winning_pool={winning_pool}, bettor_stake={bettor_stake})"
                );
            }
        }
    }
    // If `calculate_payout` returns `None`, the contract would surface
    // `ContractError::InsufficientAmount` — no invariant to assert.
});
