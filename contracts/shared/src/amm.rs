//! ============================================================
//! BANKERCHANGER — AMM Math Module
//! Automated Market Maker calculations for pool operations.
//! ============================================================

/// Constant Product AMM: k = pool_a × pool_b × pool_draw
///
/// This module implements CFMM (Constant Function Market Maker) using a three-asset
/// constant product invariant. It was chosen over LMSR for:
/// - Simplicity and auditability
/// - Proven track record in production (Uniswap, Stellar dex)
/// - Deterministic pricing and composability
/// - No reliance on parameterized liquidity curves
///
/// Key insight: pool_draw acts as the "reserve" side; FighterA and FighterB are the
/// tradeable sides. When bettors buy FighterA shares:
/// - FighterA pool shrinks (they're reducing collateral needed for that outcome)
/// - Draw pool grows (to maintain the invariant)
/// - Effective price = pool_draw / pool_a after trade (with price impact)

/// AMM tier parameters controlling per-tier liquidity requirements and slippage limits.
///
/// Each tier in the AMM & Odds Calculation Pipeline enforces different constraints
/// to match the expected market depth and bet volume:
///
/// | Tier | min_liquidity_stroops | max_slippage_bps | Description             |
/// |------|-----------------------|------------------|-------------------------|
/// | 8    | 800_000_000           | 3_000            | Entry-level markets     |
/// | 10   | 1_000_000_000         | 2_500            | Standard markets        |
/// | 12   | 1_200_000_000         | 2_000            | Established markets     |
/// | 14   | 1_400_000_000         | 1_500            | High-volume markets     |
pub struct TierParams {
    /// Minimum total pool size (in stroops) required before slippage checks apply.
    /// Below this threshold the AMM is considered bootstrapping and checks are lenient.
    pub min_liquidity_stroops: i128,
    /// Maximum price impact per bet in basis points (1 bps = 0.01%).
    /// Bets that would exceed this impact are rejected with SlippageExceeded.
    pub max_slippage_bps: i128,
}

/// Returns the [`TierParams`] for a given market tier byte.
///
/// # Arguments
/// * `tier` - Tier identifier: 8, 10, 12, or 14
///
/// # Returns
/// `Some(TierParams)` for known tiers, `None` for unknown values.
pub fn tier_params(tier: u8) -> Option<TierParams> {
    match tier {
        8 => Some(TierParams {
            min_liquidity_stroops: 800_000_000,   // 80 XLM
            max_slippage_bps: 3_000,
        }),
        10 => Some(TierParams {
            min_liquidity_stroops: 1_000_000_000, // 100 XLM
            max_slippage_bps: 2_500,
        }),
        12 => Some(TierParams {
            min_liquidity_stroops: 1_200_000_000, // 120 XLM
            max_slippage_bps: 2_000,
        }),
        14 => Some(TierParams {
            min_liquidity_stroops: 1_400_000_000, // 140 XLM
            max_slippage_bps: 1_500,
        }),
        _ => None,
    }
}

/// Checks whether a bet's slippage is within the tier's allowed tolerance.
///
/// Returns `true` (bet is acceptable) when:
/// 1. No tier params exist for the given tier (unknown tier — permissive default)
/// 2. Total pool is below `min_liquidity_stroops` (bootstrapping phase)
/// 3. `impact_bps` ≤ `max_slippage_bps` for the tier
///
/// Returns `false` when the impact exceeds the tier limit.
///
/// # Arguments
/// * `tier`       - Tier byte (8, 10, 12, or 14)
/// * `total_pool` - Current total pool size in stroops
/// * `impact_bps` - Price impact of the bet in basis points (from `compute_odds`)
pub fn check_tier_slippage(tier: u8, total_pool: i128, impact_bps: i128) -> bool {
    match tier_params(tier) {
        None => true, // Unknown tier — fall back to permissive behaviour
        Some(params) => {
            // During bootstrapping (pool below min liquidity) the strict tier
            // limit does not apply; we use the global 30 % cap instead.
            if total_pool < params.min_liquidity_stroops {
                return impact_bps <= 3_000;
            }
            impact_bps <= params.max_slippage_bps
        }
    }
}

/// Computes the oracle consensus requirement for a given tier.
///
/// All tiers use the standard 2-of-3 oracle consensus model.  The function
/// is provided so callers can query the threshold without hard-coding it, and
/// to make future per-tier changes (e.g. 3-of-5 for Tier 14) purely additive.
///
/// # Returns
/// Minimum number of matching oracle reports required to resolve the market.
pub const fn tier_oracle_consensus_threshold(_tier: u8) -> u32 {
    // All current tiers use 2-of-3 consensus.
    2
}

/// Computes integer square root for fixed-point math.
/// Used in constant product calculations to solve x² equations.
///
/// # Arguments
/// * `n` - Integer to take the square root of
///
/// # Returns
/// `Some(floor(√n))` for `n >= 0`, or `None` if `n` is negative.
/// Callers must handle `None` explicitly rather than silently receiving 0,
/// which would propagate a wrong result through the AMM calculation.
pub fn isqrt(n: i128) -> Option<i128> {
    if n < 0 {
        return None;
    }
    if n == 0 {
        return Some(0);
    }

    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    Some(x)
}

/// Computes dynamic odds using constant product AMM.
///
/// The invariant is: pool_a * pool_b * pool_draw = k (constant)
///
/// After a bet on side A with amount `bet_amount`:
/// - New pool_a = pool_a - shares_out (seller is reducing collateral for outcome A)
/// - New pool_draw = pool_draw + bet_amount (seller adds collateral to the draw pool)
/// - We solve for shares_out using the invariant
///
/// # Arguments
/// * `pool_a` - Current pool for side A (in stroops)
/// * `pool_b` - Current pool for side B (in stroops)
/// * `pool_draw` - Current pool for Draw outcome (in stroops)
/// * `bet_amount` - Size of the bet in stroops
/// * `side` - Which outcome: 0 = FighterA, 1 = FighterB, 2 = Draw
///
/// # Returns
/// Odds as (shares_out, price_impact_bps)
/// where:
/// - shares_out is the number of shares the bettor receives
/// - price_impact_bps is the price slippage in basis points (0-10000)
///
/// # Errors
/// Returns None if any pool is 0 or negative (impossible state)
pub fn compute_odds(
    pool_a: i128,
    pool_b: i128,
    pool_draw: i128,
    bet_amount: i128,
    side: u8,
) -> Option<(i128, i128)> {
    // Validate inputs
    if pool_a <= 0 || pool_b <= 0 || pool_draw <= 0 || bet_amount <= 0 {
        return None;
    }

    // Calculate the constant product invariant k
    let k = pool_a.checked_mul(pool_b)?.checked_mul(pool_draw)?;

    let (pool_out, pool_in) = match side {
        0 => (pool_a, pool_draw), // Betting on FighterA: sell FighterA, buy with draw
        1 => (pool_b, pool_draw), // Betting on FighterB: sell FighterB, buy with draw
        2 => (pool_draw, pool_a), // Betting on Draw: sell draw, buy with FighterA
        _ => return None,
    };

    // New input pool after adding bet collateral
    let new_pool_in = pool_in.checked_add(bet_amount)?;

    // Solve invariant for output: pool_out * (k / new_pool_in / other_pool)
    // For sides A/B: k / (new_pool_draw * pool_a * pool_b)
    // For draw: k / (new_pool_a * pool_b)
    let other_pool = match side {
        0 | 1 => pool_b.checked_mul(pool_a)?, // B and A remain the same for A/B bets
        2 => pool_b.checked_mul(1)?, // Only B remains constant for draw bets (multiply by 1 to keep type consistent)
        _ => return None,
    };

    // new_pool_out = k / new_pool_in / other_pool
    let new_pool_out_numerator = k / other_pool;
    let new_pool_out = new_pool_out_numerator / new_pool_in;

    // Shares received = pool_out - new_pool_out
    let shares_out = pool_out.checked_sub(new_pool_out)?;

    if shares_out <= 0 {
        return None;
    }

    // Calculate price impact in basis points
    // Reference price = pool_in / pool_out (stroops per share at current rates)
    // Executed price = bet_amount / shares_out
    // Impact = (executed_price - reference_price) / reference_price
    // In BPS: impact * 10000

    let reference_price_num = pool_in;
    let reference_price_den = pool_out;
    let executed_price_num = bet_amount;
    let executed_price_den = shares_out;

    // impact_bps = ((executed - reference) / reference) * 10000
    //            = ((bet_amount / shares_out - pool_in / pool_out) / (pool_in / pool_out)) * 10000
    //            = ((bet_amount * pool_out - pool_in * shares_out) / (pool_in * shares_out)) * 10000

    let numerator = bet_amount
        .checked_mul(pool_out)?
        .checked_sub(reference_price_num.checked_mul(shares_out)?)?;
    let denominator = reference_price_num.checked_mul(shares_out)?;

    let price_impact_bps = if denominator == 0 {
        10000 // Max slippage
    } else {
        ((numerator * 10000) / denominator).min(10000).max(0)
    };

    Some((shares_out, price_impact_bps))
}

/// Computes the maximum collateral a buyer can spend (or shares a seller can sell)
/// without draining the target reserve to zero.
///
/// Used as a guard in buy_shares and sell_shares to prevent reserve depletion.
///
/// # Arguments
/// * `reserve` - Current reserve balance in stroops
/// * `balance` - Current balance of the opposite side in stroops
///
/// # Returns
/// The largest collateral_in such that target_reserve_after >= 1
///
/// # Formula
/// Using constant product AMM: reserve * balance = k (constant)
/// After trade: (reserve - collateral_in) * (balance + shares_out) = k
/// Solving for max collateral_in where reserve_after = 1:
///   (1) * (balance + shares_out) = reserve * balance
///   shares_out = reserve * balance - balance = balance * (reserve - 1)
///   collateral_in = reserve - 1
///
/// Note: `balance` cancels out of the `collateral_in` expression above, so it does
/// not appear in the returned value. It is accepted as a parameter to keep the
/// function signature aligned with the CFMM derivation and to allow future
/// extensions (e.g., fee-adjusted or multi-asset invariants) without a breaking
/// API change. The `balance > 0` precondition is still checked to guard against
/// degenerate pool states.
pub fn calc_max_trade(reserve: i128, balance: i128) -> i128 {
    if reserve <= 1 || balance <= 0 {
        return 0;
    }
    reserve - 1
}

/// Calculates claimable LP fees for a position.
///
/// # Arguments
/// * `lp_fee_per_share` - Current accumulated fee per share
/// * `lp_fee_debt` - Fee debt recorded at position creation/last claim
/// * `lp_shares` - Number of LP shares held
///
/// # Returns
/// Amount of fees claimable in stroops
pub fn calc_claimable_lp_fees(lp_fee_per_share: i128, lp_fee_debt: i128, lp_shares: i128) -> i128 {
    if lp_shares <= 0 {
        return 0;
    }
    let fee_delta = lp_fee_per_share.saturating_sub(lp_fee_debt);
    fee_delta.saturating_mul(lp_shares) / 1_000_000
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Integer square root tests ───────────────────────────────────────────────

    #[test]
    fn test_isqrt_zero() {
        assert_eq!(isqrt(0), Some(0));
    }

    #[test]
    fn test_isqrt_one() {
        assert_eq!(isqrt(1), Some(1));
    }

    #[test]
    fn test_isqrt_perfect_squares() {
        assert_eq!(isqrt(4), Some(2));
        assert_eq!(isqrt(9), Some(3));
        assert_eq!(isqrt(16), Some(4));
        assert_eq!(isqrt(100), Some(10));
    }

    #[test]
    fn test_isqrt_non_perfect_squares() {
        assert_eq!(isqrt(5), 2); // floor(√5) = 2
        assert_eq!(isqrt(10), 3); // floor(√10) = 3
        assert_eq!(isqrt(99), 9); // floor(√99) = 9
        assert_eq!(isqrt(101), 10); // floor(√101) = 10

        assert_eq!(isqrt(5), Some(2));   // floor(√5) = 2
        assert_eq!(isqrt(10), Some(3));  // floor(√10) = 3
        assert_eq!(isqrt(99), Some(9));  // floor(√99) = 9
        assert_eq!(isqrt(101), Some(10)); // floor(√101) = 10
    }

    #[test]
    fn test_isqrt_negative_returns_none() {
        assert_eq!(isqrt(-1), None);
        assert_eq!(isqrt(-100), None);
        assert_eq!(isqrt(i128::MIN), None);
    }

    // ── compute_odds tests ──────────────────────────────────────────────────────

    #[test]
    fn test_compute_odds_equal_pools_fighter_a() {
        // With equal pools and a small bet, we should get favorable odds
        let (shares, impact) = compute_odds(1_000_000, 1_000_000, 1_000_000, 10_000, 0).unwrap();
        assert!(shares > 0);
        assert!(impact >= 0 && impact <= 10000);
    }

    #[test]
    fn test_compute_odds_equal_pools_fighter_b() {
        let (shares, impact) = compute_odds(1_000_000, 1_000_000, 1_000_000, 10_000, 1).unwrap();
        assert!(shares > 0);
        assert!(impact >= 0 && impact <= 10000);
    }

    #[test]
    fn test_compute_odds_equal_pools_draw() {
        let (shares, impact) = compute_odds(1_000_000, 1_000_000, 1_000_000, 10_000, 2).unwrap();
        assert!(shares > 0);
        assert!(impact >= 0 && impact <= 10000);
    }

    #[test]
    fn test_compute_odds_unequal_pools() {
        // Fighter A pool is larger: less shares per bet
        let (shares_a, _) = compute_odds(2_000_000, 1_000_000, 1_000_000, 10_000, 0).unwrap();
        // Fighter B pool is smaller: more shares per bet
        let (shares_b, _) = compute_odds(1_000_000, 2_000_000, 1_000_000, 10_000, 1).unwrap();
        // More shares for the smaller pool (better odds)
        assert!(shares_b > shares_a);
    }

    #[test]
    fn test_compute_odds_large_bet_increases_slippage() {
        // Small bet
        let (_shares_small, impact_small) =
            compute_odds(1_000_000, 1_000_000, 1_000_000, 1_000, 0).unwrap();
        // Large bet
        let (_shares_large, impact_large) =
            compute_odds(1_000_000, 1_000_000, 1_000_000, 100_000, 0).unwrap();
        // Larger bet = worse impact
        assert!(impact_large > impact_small);
    }

    #[test]
    fn test_compute_odds_invalid_pools() {
        assert_eq!(compute_odds(0, 1_000_000, 1_000_000, 10_000, 0), None);
        assert_eq!(compute_odds(1_000_000, 0, 1_000_000, 10_000, 0), None);
        assert_eq!(compute_odds(1_000_000, 1_000_000, 0, 10_000, 0), None);
    }

    #[test]
    fn test_compute_odds_invalid_bet_amount() {
        assert_eq!(compute_odds(1_000_000, 1_000_000, 1_000_000, 0, 0), None);
        assert_eq!(compute_odds(1_000_000, 1_000_000, 1_000_000, -100, 0), None);
    }

    #[test]
    fn test_compute_odds_invalid_side() {
        assert_eq!(
            compute_odds(1_000_000, 1_000_000, 1_000_000, 10_000, 3),
            None
        );
    }

    #[test]
    fn test_compute_odds_consistency_across_sides() {
        // With symmetric pools, different sides should produce similar odds
        let (shares_a, _) = compute_odds(1_000_000, 1_000_000, 1_000_000, 10_000, 0).unwrap();
        let (shares_b, _) = compute_odds(1_000_000, 1_000_000, 1_000_000, 10_000, 1).unwrap();
        let (shares_draw, _) = compute_odds(1_000_000, 1_000_000, 1_000_000, 10_000, 2).unwrap();
        // With symmetric pools, odds should be very similar
        assert!((shares_a - shares_b).abs() < 1000);
        assert!((shares_a - shares_draw).abs() < 1000);
    }

    #[test]
    fn test_compute_odds_draw_cfmm_invariant() {
        // Verify that Draw bet respects the 3-asset CFMM invariant
        // k = pool_a * pool_b * pool_draw (constant)
        let pool_a = 1_000_000i128;
        let pool_b = 1_000_000i128;
        let pool_draw = 1_000_000i128;
        let bet_amount = 50_000i128;

        // Initial invariant
        let k = pool_a * pool_b * pool_draw;

        // Bet on Draw: bettor adds bet_amount to pool_a, receives shares_draw from pool_draw
        let (shares_draw, _) = compute_odds(pool_a, pool_b, pool_draw, bet_amount, 2).unwrap();

        // After the bet:
        // new_pool_a = pool_a + bet_amount (bettor adds collateral)
        // new_pool_b = pool_b (unchanged for draw bet)
        // new_pool_draw = pool_draw - shares_draw (bettor receives shares)
        let new_pool_a = pool_a + bet_amount;
        let new_pool_b = pool_b;
        let new_pool_draw = pool_draw - shares_draw;

        // Verify the invariant holds
        let k_new = new_pool_a * new_pool_b * new_pool_draw;
        assert_eq!(
            k, k_new,
            "CFMM invariant violated for Draw bet: k={} != k_new={}",
            k, k_new
        );
    }

    #[test]
    fn test_compute_odds_draw_shares_correctness() {
        // Verify that Draw bet shares are correctly calculated
        // Using the example from the bug report: compute_odds(1_000_000, 1_000_000, 1_000_000, 50_000, 2)
        let pool_a = 1_000_000i128;
        let pool_b = 1_000_000i128;
        let pool_draw = 1_000_000i128;
        let bet_amount = 50_000i128;

        let (shares_draw, _) = compute_odds(pool_a, pool_b, pool_draw, bet_amount, 2).unwrap();

        // Manual calculation:
        // k = 1_000_000 * 1_000_000 * 1_000_000 = 1e18
        // new_pool_a = 1_000_000 + 50_000 = 1_050_000
        // new_pool_draw = k / (new_pool_a * pool_b) = 1e18 / (1_050_000 * 1_000_000)
        //               = 1e18 / 1_050_000_000_000 ≈ 952_380.95
        // shares_out = pool_draw - new_pool_draw ≈ 1_000_000 - 952_380 = 47_619 (approx, due to integer division)

        let k = pool_a as i128 * pool_b as i128 * pool_draw as i128;
        let new_pool_a = pool_a + bet_amount;
        let new_pool_draw_numerator = k / (new_pool_a * pool_b);
        let expected_shares = pool_draw - new_pool_draw_numerator;

        assert_eq!(shares_draw, expected_shares);
        // Shares should be reasonable (not zero, not huge)
        assert!(shares_draw > 0);
        assert!(shares_draw < bet_amount * 2); // Sanity check
    }

    #[test]
    fn test_compute_odds_price_impact_bounds() {
        let (_, impact) = compute_odds(1_000_000, 1_000_000, 1_000_000, 500_000, 0).unwrap();
        // Impact should always be between 0 and 10000 BPS
        assert!(impact >= 0);
        assert!(impact <= 10000);
    }

    // ── Property-based fuzz tests: overflow/underflow near i128 boundaries ──────

    #[test]
    fn test_compute_odds_near_i128_max_does_not_panic() {
        // Near-max pool values — the function must return None rather than panic
        let near_max = i128::MAX / 3; // large enough so product doesn't overflow in the first mul
        let result = compute_odds(near_max, near_max, near_max, 1_000_000, 0);
        // Must not panic; may succeed or return None
        if let Some((shares, impact)) = result {
            assert!(shares > 0);
            assert!(impact <= 10000);
        }
    }

    #[test]
    fn test_compute_odds_overflow_returns_none() {
        // Pool product k = pool_a * pool_b * pool_draw will overflow i128
        // i128::MAX / 2 cubed is way over i128::MAX
        let big = i128::MAX / 2;
        let result = compute_odds(big, big, big, 1, 0);
        assert_eq!(result, None, "Overflow must return None, not panic");
    }

    #[test]
    fn test_compute_odds_extreme_bet_amount_does_not_panic() {
        // Bet amount near i128::MAX — pool_in + bet_amount may overflow
        let result = compute_odds(1_000_000, 1_000_000, 1_000_000, i128::MAX, 0);
        // Must not panic; overflow should return None
        assert_eq!(result, None, "i128::MAX bet must return None gracefully");
    }

    #[test]
    fn test_compute_odds_near_zero_pools() {
        // Pools at 1 (minimum valid) — should still work
        let result = compute_odds(1, 1, 1, 1, 0);
        // With pools=1, the math may or may not produce valid output
        // The key invariant: must not panic
        if let Some((shares, impact)) = result {
            assert!(shares > 0);
            assert!(impact <= 10000);
        }
    }

    #[test]
    fn test_compute_odds_negative_pool_rejected() {
        assert_eq!(compute_odds(-1, 1_000_000, 1_000_000, 10_000, 0), None);
        assert_eq!(compute_odds(1_000_000, -1, 1_000_000, 10_000, 0), None);
        assert_eq!(compute_odds(1_000_000, 1_000_000, -1, 10_000, 0), None);
    }

    // ── tier_params tests ───────────────────────────────────────────────────────

    /// Tier 8 params: 80 XLM min liquidity, 30 % max slippage.
    #[test]
    fn test_tier_params_tier8() {
        let p = tier_params(8).expect("tier 8 must exist");
        assert_eq!(p.min_liquidity_stroops, 800_000_000);
        assert_eq!(p.max_slippage_bps, 3_000);
    }

    /// Tier 10 params: 100 XLM min liquidity, 25 % max slippage.
    #[test]
    fn test_tier_params_tier10() {
        let p = tier_params(10).expect("tier 10 must exist");
        assert_eq!(p.min_liquidity_stroops, 1_000_000_000);
        assert_eq!(p.max_slippage_bps, 2_500);
    }

    /// Tier 12 params: 120 XLM min liquidity, 20 % max slippage.
    #[test]
    fn test_tier_params_tier12() {
        let p = tier_params(12).expect("tier 12 must exist");
        assert_eq!(p.min_liquidity_stroops, 1_200_000_000);
        assert_eq!(p.max_slippage_bps, 2_000);
    }

    /// Tier 14 params: 140 XLM min liquidity, 15 % max slippage.
    #[test]
    fn test_tier_params_tier14() {
        let p = tier_params(14).expect("tier 14 must exist");
        assert_eq!(p.min_liquidity_stroops, 1_400_000_000);
        assert_eq!(p.max_slippage_bps, 1_500);
    }

    /// Unknown tier returns None — permissive fallback.
    #[test]
    fn test_tier_params_unknown() {
        assert!(tier_params(0).is_none());
        assert!(tier_params(7).is_none());
        assert!(tier_params(9).is_none());
        assert!(tier_params(255).is_none());
    }

    // ── check_tier_slippage tests ───────────────────────────────────────────────

    /// Below the min-liquidity bootstrap threshold, a 30 % impact is still accepted.
    #[test]
    fn test_check_tier_slippage_bootstrapping_phase_accepts_high_impact() {
        // Pool below 80 XLM → bootstrapping
        assert!(check_tier_slippage(8, 100_000, 3_000));
        assert!(check_tier_slippage(10, 100_000, 3_000));
        assert!(check_tier_slippage(12, 100_000, 3_000));
        assert!(check_tier_slippage(14, 100_000, 3_000));
    }

    /// Above the min-liquidity threshold, tier-specific limits apply.
    #[test]
    fn test_check_tier_slippage_above_min_liquidity_enforces_tier_limit() {
        // Tier 8 (30 %): 3000 bps is exactly the limit — accept.
        assert!(check_tier_slippage(8, 2_000_000_000, 3_000));
        // Tier 8: 3001 bps exceeds the limit — reject.
        assert!(!check_tier_slippage(8, 2_000_000_000, 3_001));

        // Tier 10 (25 %): 2500 bps is exactly the limit — accept.
        assert!(check_tier_slippage(10, 2_000_000_000, 2_500));
        // Tier 10: 2501 bps exceeds the limit — reject.
        assert!(!check_tier_slippage(10, 2_000_000_000, 2_501));

        // Tier 12 (20 %): 2000 bps is exactly the limit — accept.
        assert!(check_tier_slippage(12, 2_000_000_000, 2_000));
        // Tier 12: 2001 bps exceeds the limit — reject.
        assert!(!check_tier_slippage(12, 2_000_000_000, 2_001));

        // Tier 14 (15 %): 1500 bps is exactly the limit — accept.
        assert!(check_tier_slippage(14, 2_000_000_000, 1_500));
        // Tier 14: 1501 bps exceeds the limit — reject.
        assert!(!check_tier_slippage(14, 2_000_000_000, 1_501));
    }

    /// Unknown tier falls back to permissive behaviour (always true).
    #[test]
    fn test_check_tier_slippage_unknown_tier_is_permissive() {
        assert!(check_tier_slippage(0, 2_000_000_000, 10_000));
        assert!(check_tier_slippage(7, 2_000_000_000, 10_000));
    }

    // ── tier_oracle_consensus_threshold tests ────────────────────────────────────

    #[test]
    fn test_tier_oracle_consensus_threshold_all_tiers() {
        for tier in [0u8, 8, 10, 12, 14, 255] {
            assert_eq!(tier_oracle_consensus_threshold(tier), 2,
                "all tiers must require 2-of-3 consensus");
        }
    }
}

/// Property-based fuzz tests exercising random pool sizes across the full i128 range.
/// These guard against checked-arithmetic panics that hand-crafted tests miss.
#[cfg(test)]
mod proptest_tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        /// For any random positive pool values and valid bet, compute_odds must never panic.
        #[test]
        fn fuzz_compute_odds_never_panics(
            pool_a in 1i128..=i128::MAX,
            pool_b in 1i128..=i128::MAX,
            pool_draw in 1i128..=i128::MAX,
            bet_amount in 1i128..=1_000_000_000_000i128,
            side in 0u8..=2u8,
        ) {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                compute_odds(pool_a, pool_b, pool_draw, bet_amount, side)
            }));
            // Must never panic — either return Some or None
            assert!(result.is_ok(), "compute_odds panicked with pools ({pool_a}, {pool_b}, {pool_draw}), bet {bet_amount}, side {side}");
        }

        /// For random pool sizes near i128::MAX, the function must not panic.
        #[test]
        fn fuzz_compute_odds_near_max_never_panics(
            offset_a in 0i128..=1_000_000i128,
            offset_b in 0i128..=1_000_000i128,
            offset_draw in 0i128..=1_000_000i128,
            bet_amount in 1i128..=1_000_000_000i128,
            side in 0u8..=2u8,
        ) {
            let pool_a = i128::MAX.saturating_sub(offset_a).max(1);
            let pool_b = i128::MAX.saturating_sub(offset_b).max(1);
            let pool_draw = i128::MAX.saturating_sub(offset_draw).max(1);

            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                compute_odds(pool_a, pool_b, pool_draw, bet_amount, side)
            }));
            assert!(result.is_ok(), "compute_odds panicked near MAX with pools ({pool_a}, {pool_b}, {pool_draw})");
        }

        /// For any valid inputs that succeed, the output invariants hold.
        #[test]
        fn fuzz_compute_odds_output_invariants(
            pool_a in 1i128..=1_000_000_000_000i128,
            pool_b in 1i128..=1_000_000_000_000i128,
            pool_draw in 1i128..=1_000_000_000_000i128,
            bet_amount in 1i128..=1_000_000_000i128,
            side in 0u8..=2u8,
        ) {
            if let Some((shares, impact)) = compute_odds(pool_a, pool_b, pool_draw, bet_amount, side) {
                // shares must be positive
                assert!(shares > 0, "shares must be > 0, got {shares}");
                // shares must not exceed the output pool
                let out_pool = match side {
                    0 => pool_a,
                    1 => pool_b,
                    2 => pool_draw,
                    _ => unreachable!(),
                };
                assert!(shares < out_pool, "shares {shares} must be < out_pool {out_pool}");
                // price impact must be in [0, 10000] bps
                assert!(impact <= 10000, "impact {impact} must be <= 10000");
            }
        }

        /// Random pool sizes across the full i128 range — must never panic.
        #[test]
        fn fuzz_full_i128_range_never_panics(
            pool_a in any::<i128>(),
            pool_b in any::<i128>(),
            pool_draw in any::<i128>(),
            bet_amount in any::<i128>(),
            side in 0u8..=3u8,
        ) {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                compute_odds(pool_a, pool_b, pool_draw, bet_amount, side)
            }));
            assert!(result.is_ok(), "compute_odds panicked with any i128 inputs");
        }
    }

    // ── calc_max_trade tests ────────────────────────────────────────────────────

    #[test]
    fn test_calc_max_trade_normal() {
        assert_eq!(calc_max_trade(100, 50), 99);
    }

    #[test]
    fn test_calc_max_trade_reserve_one() {
        assert_eq!(calc_max_trade(1, 50), 0);
    }

    #[test]
    fn test_calc_max_trade_reserve_zero() {
        assert_eq!(calc_max_trade(0, 50), 0);
    }

    #[test]
    fn test_calc_max_trade_zero_balance_rejected() {
        // balance = 0 is a degenerate pool state; guard returns 0
        assert_eq!(calc_max_trade(100, 0), 0);
    }

    #[test]
    fn test_calc_max_trade_negative_balance_rejected() {
        // negative balance should never occur but must not silently produce a result
        assert_eq!(calc_max_trade(100, -1), 0);
    }

    // ── calc_claimable_lp_fees tests ────────────────────────────────────────────

    #[test]
    fn test_calc_claimable_lp_fees_no_shares() {
        assert_eq!(calc_claimable_lp_fees(1000, 500, 0), 0);
    }

    #[test]
    fn test_calc_claimable_lp_fees_no_delta() {
        assert_eq!(calc_claimable_lp_fees(1000, 1000, 100), 0);
    }

    #[test]
    fn test_calc_claimable_lp_fees_normal() {
        let fees = calc_claimable_lp_fees(2_000_000, 1_000_000, 100_000_000);
        assert!(fees > 0);
        // Fee delta = 1_000_000, shares = 100_000_000
        // Result = 1_000_000 * 100_000_000 / 1_000_000 = 100_000_000
        assert_eq!(fees, 100_000_000);
    }
}
