//! ============================================================
//! BOXMEOUT — AMM Math Module
//! Automated Market Maker calculations for pool operations.
//! ============================================================
//!
//! # AMM Model: Constant Product
//!
//! This module implements a **Constant Product AMM** (like Uniswap v2):
//! - k = pool_a * pool_b * pool_draw = constant
//! - When bets are placed, pools rebalance to maintain k
//! - Price impact increases non-linearly with bet size
//! - Prevents exploitation by large bets before lockout
//!
//! # Why Constant Product over LMSR?
//! - Proven: 8+ years on Ethereum/Polygon
//! - Simple: Easy to audit on-chain
//! - Efficient: Low compute on Soroban
//! - Natural price discovery without admin knobs

use soroban_sdk::math::I256;

/// Computes dynamic odds for a bet using Constant Product AMM.
///
/// # Formula
/// k = pool_a × pool_b × pool_draw (invariant - stays constant)
///
/// When bet of size `amount` placed on `side`:
/// 1. Source pool increases: new_pool = old_pool + amount
/// 2. Other pools rebalance: new_pool_other = sqrt(k / new_pool)
/// 3. Shares received = sum of reductions in other pools
/// 4. Odds = (shares_received / amount) × 10,000 basis points
///
/// # Arguments
/// * `pool_a` - Current pool balance for Fighter A (stroops)
/// * `pool_b` - Current pool balance for Fighter B (stroops)
/// * `pool_draw` - Current pool balance for Draw (stroops)
/// * `bet_amount` - Amount being wagered (stroops)
/// * `side` - Which outcome: 0=FighterA, 1=FighterB, 2=Draw
///
/// # Returns
/// (shares_received, odds_bps) where odds_bps = basis points × 10,000
///
/// # Example: Equal 1M pools, 100K bet
/// ```text
/// k = 1M × 1M × 1M = 10^18
/// new_pool_source = 1.1M
/// new_pool_other = sqrt(10^18 / 1.1M) ≈ 953K
/// shares = 2 × (1M - 953K) = 94K
/// odds = (94K / 100K) × 10,000 = 9,400 bps (0.94x)
/// → 6% price impact for 10% liquidity depth
/// ```
pub fn compute_odds(
    pool_a: i128,
    pool_b: i128,
    pool_draw: i128,
    bet_amount: i128,
    side: u32,
) -> (i128, i128) {
    // Validate inputs
    assert!(pool_a > 0, "pool_a must be positive");
    assert!(pool_b > 0, "pool_b must be positive");
    assert!(pool_draw > 0, "pool_draw must be positive");
    assert!(bet_amount > 0, "bet_amount must be positive");
    assert!(side <= 2, "side must be 0, 1, or 2");

    // Identify source pool and counterparty pools
    let (my_pool, other_pool_1, other_pool_2) = match side {
        0 => (pool_a, pool_b, pool_draw),     // Betting on FighterA
        1 => (pool_b, pool_a, pool_draw),     // Betting on FighterB
        2 => (pool_draw, pool_a, pool_b),     // Betting on Draw
        _ => panic!("Invalid side"),
    };

    // Compute invariant k
    let k = my_pool
        .checked_mul(other_pool_1)
        .and_then(|r| r.checked_mul(other_pool_2))
        .expect("k calculation overflow");

    // New source pool after bet
    let new_my_pool = my_pool
        .checked_add(bet_amount)
        .expect("new_my_pool overflow");

    // Rebalance other pools while maintaining k
    // k = new_my_pool × new_other_1 × new_other_2
    // Assume symmetric rebalancing: new_other_1 = new_other_2 = sqrt(k / new_my_pool)
    let k_div_new = k / new_my_pool;
    let new_other_balance = isqrt(k_div_new);

    // Calculate shares received as reduction from both counterparty pools
    let shares_from_pool_1 = other_pool_1.saturating_sub(new_other_balance);
    let shares_from_pool_2 = other_pool_2.saturating_sub(new_other_balance);
    let total_shares = shares_from_pool_1.saturating_add(shares_from_pool_2);

    // Calculate odds in basis points (10,000 = 1.0x fair odds)
    let odds_bps = if total_shares > 0 {
        let shares_i256 = I256::from_i128(total_shares);
        let bet_i256 = I256::from_i128(bet_amount);
        let multiplier = I256::from_i128(10_000);

        let odds_i256 = (shares_i256 * multiplier) / bet_i256;
        let odds_i128 = odds_i256.as_i128().expect("odds overflow");

        odds_i128.max(100) // Minimum 1% odds
    } else {
        100
    };

    (total_shares, odds_bps)
}

/// Integer square root using binary search.
/// 
/// Computes floor(sqrt(n)) for use in AMM calculations.
fn isqrt(n: i128) -> i128 {
    if n == 0 {
        return 0;
    }
    if n < 0 {
        panic!("isqrt: negative input");
    }

    let mut low: i128 = 0;
    let mut high: i128 = (n as f64).sqrt() as i128 + 2;

    while low <= high {
        let mid = low + (high - low) / 2;
        let sq = mid.checked_mul(mid).unwrap_or(i128::MAX);

        match sq.cmp(&n) {
            std::cmp::Ordering::Equal => return mid,
            std::cmp::Ordering::Less => low = mid + 1,
            std::cmp::Ordering::Greater => high = mid - 1,
        }
    }

    high
}

/// Computes the maximum collateral a buyer can spend (or shares a seller can sell)
/// without draining the target reserve to zero.
///
/// Used as a guard in buy_shares and sell_shares to prevent reserve depletion.
///
/// # Arguments
/// * `reserve` - Current reserve balance in stroops
/// * `_balance` - Current balance of the opposite side in stroops
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

    /// Test: Equal pools with moderate bet size
    #[test]
    fn test_compute_odds_equal_pools() {
        // Pools: 1M each, Bet: 100K on FighterA
        let (shares, odds_bps) = compute_odds(1_000_000, 1_000_000, 1_000_000, 100_000, 0);

        // Should receive shares and have non-trivial odds
        assert!(shares > 0, "Should receive shares");
        assert!(odds_bps > 0, "Should have positive odds");
        assert!(odds_bps < 10_000, "Should have price impact");
        println!(
            "Equal pools test: 100K bet → {} shares at {} bps",
            shares, odds_bps
        );
    }

    /// Test: Small bet relative to pool depth
    #[test]
    fn test_compute_odds_small_bet() {
        // Pools: 10M each, Bet: 1K on FighterA
        let (shares, odds_bps) = compute_odds(10_000_000, 10_000_000, 10_000_000, 1_000, 0);

        assert!(shares > 0, "Should receive shares");
        // Small bet should have minimal impact; odds near 10,000 bps (1.0x)
        assert!(odds_bps >= 9_800, "Small bet should give near-fair odds");
        println!("Small bet test: 1K bet → {} shares at {} bps", shares, odds_bps);
    }

    /// Test: Large bet creates significant price impact
    #[test]
    fn test_compute_odds_large_bet() {
        let pool = 1_000_000;

        // Smaller bet
        let (shares_small, odds_small) = compute_odds(pool, pool, pool, 100_000, 0);
        // Larger bet (5x)
        let (shares_large, odds_large) = compute_odds(pool, pool, pool, 500_000, 0);

        // Verify price impact non-linearity
        let rate_small = (shares_small as f64) / 100_000.0;
        let rate_large = (shares_large as f64) / 500_000.0;

        assert!(
            rate_small > rate_large,
            "Larger bets should have worse effective rates"
        );
        println!(
            "Price impact: 100K bet {} bps vs 500K bet {} bps",
            odds_small, odds_large
        );
    }

    /// Test: All three outcomes work correctly
    #[test]
    fn test_compute_odds_different_sides() {
        let pools = (1_000_000, 1_000_000, 1_000_000);
        let bet = 100_000;

        let (shares_a, odds_a) = compute_odds(pools.0, pools.1, pools.2, bet, 0);
        let (shares_b, odds_b) = compute_odds(pools.0, pools.1, pools.2, bet, 1);
        let (shares_draw, odds_draw) = compute_odds(pools.0, pools.1, pools.2, bet, 2);

        // All should work
        assert!(shares_a > 0 && shares_b > 0 && shares_draw > 0);
        assert!(odds_a > 0 && odds_b > 0 && odds_draw > 0);

        println!(
            "All sides: A={} bps, B={} bps, Draw={} bps",
            odds_a, odds_b, odds_draw
        );
    }

    /// Test: Imbalanced pools offer better odds for underdog
    #[test]
    fn test_compute_odds_unequal_pools() {
        // Market heavily favors FighterA (10M vs 100K)
        let pools_favored = (10_000_000, 100_000, 100_000);
        let pools_equal = (1_000_000, 1_000_000, 1_000_000);
        let bet = 100_000;

        // Bet on FighterB (underdog in favored market)
        let (_, odds_underdog) = compute_odds(pools_favored.0, pools_favored.1, pools_favored.2, bet, 1);
        // Bet on FighterB in balanced market
        let (_, odds_balanced) = compute_odds(pools_equal.0, pools_equal.1, pools_equal.2, bet, 1);

        // Underdog should offer better odds (natural arbitrage)
        assert!(odds_underdog > odds_balanced, "Underdog should offer better odds");
        println!(
            "Underdog market: {} bps vs balanced: {} bps",
            odds_underdog, odds_balanced
        );
    }

    /// Test: Error handling for zero pool
    #[test]
    #[should_panic(expected = "pool_a must be positive")]
    fn test_compute_odds_zero_pool() {
        compute_odds(0, 1_000_000, 1_000_000, 100_000, 0);
    }

    /// Test: Error handling for zero bet
    #[test]
    #[should_panic(expected = "bet_amount must be positive")]
    fn test_compute_odds_zero_bet() {
        compute_odds(1_000_000, 1_000_000, 1_000_000, 0, 0);
    }

    /// Test: Integer square root correctness
    #[test]
    fn test_isqrt() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(9), 3);
        assert_eq!(isqrt(16), 4);
        assert_eq!(isqrt(25), 5);
        assert_eq!(isqrt(100), 10);
        assert_eq!(isqrt(1_000_000), 1_000);

        // Non-perfect squares
        assert_eq!(isqrt(2), 1);
        assert_eq!(isqrt(3), 1);
        assert_eq!(isqrt(8), 2);
        assert_eq!(isqrt(15), 3);
    }

    /// Test: Reserve protection
    #[test]
    fn test_calc_max_trade() {
        assert_eq!(calc_max_trade(0, 1_000_000), 0);
        assert_eq!(calc_max_trade(1, 1_000_000), 0);
        assert_eq!(calc_max_trade(2, 1_000_000), 1);
        assert_eq!(calc_max_trade(1_000_000, 1_000_000), 999_999);
    }

    /// Test: LP fee calculations
    #[test]
    fn test_calc_claimable_lp_fees() {
        assert_eq!(calc_claimable_lp_fees(1_000_000, 0, 0), 0);

        let claimable = calc_claimable_lp_fees(1_000_000, 500_000, 1_000_000);
        let expected = (1_000_000 - 500_000) * 1_000_000 / 1_000_000;
        assert_eq!(claimable, expected);
    }
}
