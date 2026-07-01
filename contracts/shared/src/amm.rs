//! ============================================================
//! BOXMEOUT — AMM Math Module
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

/// Computes integer square root for fixed-point math.
/// Used in constant product calculations to solve x² equations.
///
/// # Arguments
/// * `n` - Non-negative integer to take the square root of
///
/// # Returns
/// Floor of the square root
pub fn isqrt(n: i128) -> i128 {
    if n < 0 {
        return 0;
    }
    if n == 0 {
        return 0;
    }

    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
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
    let k = pool_a
        .checked_mul(pool_b)?
        .checked_mul(pool_draw)?;

    let (pool_out, pool_in) = match side {
        0 => (pool_a, pool_draw),    // Betting on FighterA: sell FighterA, buy with draw
        1 => (pool_b, pool_draw),    // Betting on FighterB: sell FighterB, buy with draw
        2 => (pool_draw, pool_a),    // Betting on Draw: sell draw, buy with FighterA
        _ => return None,
    };

    // New input pool after adding bet collateral
    let new_pool_in = pool_in.checked_add(bet_amount)?;

    // Solve invariant for output: pool_out * (k / new_pool_in / other_pool)
    // For sides A/B: k / new_pool_draw = pool_a * pool_b
    // For draw: k / new_pool_a = pool_b * pool_draw
    let other_pool = match side {
        0 | 1 => pool_b.checked_mul(pool_a)?,  // B and A remain the same for A/B bets
        2 => pool_b.checked_mul(pool_draw)?,   // B and draw remain the same for draw bets
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
/// (1) * (balance + shares_out) = reserve * balance
/// shares_out = reserve * balance - balance
/// collateral_in = reserve - 1
pub fn calc_max_trade(reserve: i128, _balance: i128) -> i128 {
    if reserve <= 1 {
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
pub fn calc_claimable_lp_fees(
    lp_fee_per_share: i128,
    lp_fee_debt: i128,
    lp_shares: i128,
) -> i128 {
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
        assert_eq!(isqrt(0), 0);
    }

    #[test]
    fn test_isqrt_one() {
        assert_eq!(isqrt(1), 1);
    }

    #[test]
    fn test_isqrt_perfect_squares() {
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(9), 3);
        assert_eq!(isqrt(16), 4);
        assert_eq!(isqrt(100), 10);
    }

    #[test]
    fn test_isqrt_non_perfect_squares() {
        assert_eq!(isqrt(5), 2);   // floor(√5) = 2
        assert_eq!(isqrt(10), 3);  // floor(√10) = 3
        assert_eq!(isqrt(99), 9);  // floor(√99) = 9
        assert_eq!(isqrt(101), 10); // floor(√101) = 10
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
        assert_eq!(compute_odds(1_000_000, 1_000_000, 1_000_000, 10_000, 3), None);
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
    fn test_compute_odds_price_impact_bounds() {
        let (_, impact) = compute_odds(1_000_000, 1_000_000, 1_000_000, 500_000, 0).unwrap();
        // Impact should always be between 0 and 10000 BPS
        assert!(impact >= 0);
        assert!(impact <= 10000);
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
