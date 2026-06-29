//! ============================================================
//! BOXMEOUT — AMM Math Module
//! Automated Market Maker calculations for pool operations.
//! ============================================================
//!
//! # AMM Model: Constant Product
//!
//! This module implements a **Constant Product AMM** similar to Uniswap v2,
//! where the product of pool reserves remains constant:
//!
//! ```text
//! k = pool_a * pool_b * pool_draw = constant
//! ```
//!
//! When a bettor places a bet of size `amount` on outcome A:
//! - Collateral (USDC) enters the pool → pool_a increases
//! - Shares of outcome A leave the pool → implied price increases
//!
//! The price impact formula ensures:
//! - Small bets get near-market odds
//! - Large bets pay a premium (create price impact)
//! - Slippage protection prevents sandwich attacks
//!
//! # Why Constant Product?
//! - **Proven:** Deployed on Ethereum/Polygon for years
//! - **Simple:** Easy to audit and verify on-chain
//! - **Efficient:** Low gas / compute on resource-constrained blockchains
//! - **Natural:** Emergence of market prices from pool balances
//!
//! # Alternative Considered: LMSR (Logarithmic Market Scoring Rule)
//! - Better for prediction markets (smooth pricing)
//! - More complex math (requires fixed-point log/exp)
//! - Harder to audit on-chain
//! - Not chosen for MVP to reduce implementation complexity

use soroban_sdk::math::I256;
use crate::ContractError;

/// Computes dynamic odds for a bet on a specific outcome.
///
/// Uses constant-product AMM formula: k = pool_a * pool_b * pool_draw
///
/// When a bettor places `bet_amount` on a side, we solve for the new pool balance:
/// - Input: bet_amount (USDC staked)
/// - Output: shares received from the pool
///
/// The ratio (shares_out / bet_amount) is the effective odds offered.
///
/// # Arguments
/// * `pool_a` - Current pool balance for Fighter A (stroops)
/// * `pool_b` - Current pool balance for Fighter B (stroops)
/// * `pool_draw` - Current pool balance for Draw (stroops)
/// * `bet_amount` - Amount being wagered on the selected side (stroops)
/// * `side` - Which outcome: 0=FighterA, 1=FighterB, 2=Draw
///
/// # Returns
/// Result with tuple: (shares_received, effective_odds_bps)
/// - shares_received: Number of outcome shares bettor receives
/// - effective_odds_bps: Effective odds in basis points (100 = 1.0x)
///
/// # Example
/// If bettor gets 900 shares for 1000 stroops, odds = 900/1000 = 0.9x = 9000 bps
pub fn compute_odds(
    pool_a: i128,
    pool_b: i128,
    pool_draw: i128,
    bet_amount: i128,
    side: u32,
) -> Result<(i128, i128), ContractError> {
    // Validate inputs
    if pool_a <= 0 || pool_b <= 0 || pool_draw <= 0 {
        return Err(ContractError::InvalidMarketParameters);
    }
    if bet_amount <= 0 {
        return Err(ContractError::BelowMinimum);
    }
    if side > 2 {
        return Err(ContractError::InvalidOutcome);
    }

    // Identify which pool we're trading into and which are the counterparties
    let (my_pool, other_pool_1, other_pool_2) = match side {
        0 => (pool_a, pool_b, pool_draw),     // Betting on FighterA
        1 => (pool_b, pool_a, pool_draw),     // Betting on FighterB
        2 => (pool_draw, pool_a, pool_b),     // Betting on Draw
        _ => return Err(ContractError::InvalidOutcome),
    };

    // Compute k (the constant product invariant)
    // Using i128 to avoid overflow during multiplication
    let k = my_pool
        .checked_mul(other_pool_1)
        .and_then(|r| r.checked_mul(other_pool_2))
        .ok_or(ContractError::InvalidMarketParameters)?;

    // After bet: new_my_pool = my_pool + bet_amount
    let new_my_pool = my_pool
        .checked_add(bet_amount)
        .ok_or(ContractError::InvalidMarketParameters)?;

    // Solve for new counterparty pools: other_pool_1' * other_pool_2' = k / new_my_pool
    // We assume equal rebalancing: new_other_1 = new_other_2 = sqrt(k / new_my_pool)
    // Shares received = (other_pool_1 + other_pool_2) - (new_other_1 + new_other_2)
    
    let k_div_new = k / new_my_pool;
    
    // Compute sqrt(k / new_my_pool) using integer approximation
    // This is the new balance for each of the other two pools
    let new_other_balance = isqrt(k_div_new);

    // Total shares received is the sum of reductions from both counterparty pools
    let shares_from_pool_1 = other_pool_1.saturating_sub(new_other_balance);
    let shares_from_pool_2 = other_pool_2.saturating_sub(new_other_balance);
    let total_shares_received = shares_from_pool_1.saturating_add(shares_from_pool_2);

    if total_shares_received == 0 {
        return Err(ContractError::InsufficientAmount);
    }

    // Compute effective odds in basis points
    // odds_bps = (shares_received / bet_amount) * 10_000
    let odds_bps = if total_shares_received > 0 {
        // Use i256 to avoid overflow
        let shares_i256 = I256::from_i128(total_shares_received);
        let bet_i256 = I256::from_i128(bet_amount);
        let multiplier = I256::from_i128(10_000);
        
        let odds_i256 = (shares_i256 * multiplier) / bet_i256;
        let odds_i128 = odds_i256.as_i128().ok_or(ContractError::InvalidMarketParameters)?;
        
        odds_i128.max(100) // Minimum odds of 1% to prevent arithmetic issues
    } else {
        100 // Fallback to 1x odds if no shares (edge case)
    };

    Ok((total_shares_received, odds_bps))
}

/// Integer square root using Newton's method.
///
/// Computes floor(sqrt(n)) using binary search for efficiency on fixed-bit integers.
///
/// # Arguments
/// * `n` - Non-negative integer
///
/// # Returns
/// floor(sqrt(n))
///
/// # Example
/// isqrt(16) = 4
/// isqrt(17) = 4
/// isqrt(25) = 5
fn isqrt(n: i128) -> i128 {
    if n == 0 {
        return 0;
    }
    if n < 0 {
        panic!("isqrt: negative input");
    }

    // Binary search for the square root
    let mut low: i128 = 0;
    let mut high: i128 = (n as f64).sqrt() as i128 + 2; // Rough upper bound

    while low <= high {
        let mid = low + (high - low) / 2;
        let sq = mid.checked_mul(mid).unwrap_or(i128::MAX);

        match sq.cmp(&n) {
            std::cmp::Ordering::Equal => return mid,
            std::cmp::Ordering::Less => low = mid + 1,
            std::cmp::Ordering::Greater => high = mid - 1,
        }
    }

    high // Return floor(sqrt(n))
}

/// Computes the maximum collateral a buyer can spend (or shares a seller can sell)
/// without draining the target reserve to zero.
///
/// Used as a guard in buy_shares and sell_shares to prevent reserve depletion.
///
/// # Arguments
/// * `reserve` - Current reserve balance in stroops
/// * `_balance` - Current balance of the opposite side in stroops (for extensibility)
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

    #[test]
    fn test_compute_odds_equal_pools() {
        // Equal pools (1M each) — betting 100K should give ~9% odds impact
        let result = compute_odds(1_000_000, 1_000_000, 1_000_000, 100_000, 0);
        
        assert!(result.is_ok());
        let (shares, odds_bps) = result.unwrap();
        
        assert!(shares > 0, "Should receive shares");
        assert!(odds_bps > 0, "Should have positive odds");
        // With equal pools and 10% increase, expect sqrt-based rebalancing
        println!(
            "Equal pools: bet 100K, got {} shares at {} bps",
            shares, odds_bps
        );
    }

    #[test]
    fn test_compute_odds_small_bet() {
        // Very small bet relative to pools — should get near 1.0x odds
        let result = compute_odds(10_000_000, 10_000_000, 10_000_000, 1_000, 0);
        
        assert!(result.is_ok());
        let (shares, odds_bps) = result.unwrap();
        
        assert!(shares > 0, "Should receive shares");
        // Small bet should have minimal price impact; odds near 10_000 bps (1.0x)
        assert!(odds_bps >= 9_500, "Small bet should give near-fair odds");
        println!("Small bet: {} shares at {} bps", shares, odds_bps);
    }

    #[test]
    fn test_compute_odds_large_bet() {
        // Large bet relative to pools — should see significant impact
        let result_small = compute_odds(1_000_000, 1_000_000, 1_000_000, 100_000, 0);
        let result_large = compute_odds(1_000_000, 1_000_000, 1_000_000, 500_000, 0);
        
        assert!(result_small.is_ok() && result_large.is_ok());
        
        let (shares_small, odds_small) = result_small.unwrap();
        let (shares_large, odds_large) = result_large.unwrap();
        
        // Larger bet should receive fewer shares per unit of collateral
        let effective_rate_small = (shares_small as f64) / 100_000.0;
        let effective_rate_large = (shares_large as f64) / 500_000.0;
        
        assert!(
            effective_rate_small > effective_rate_large,
            "Larger bets should have worse rates (price impact)"
        );
        println!(
            "Large bet impact: {} bps vs {} bps",
            odds_small, odds_large
        );
    }

    #[test]
    fn test_compute_odds_different_sides() {
        // Betting on different outcomes should all work
        let pools = (1_000_000, 1_000_000, 1_000_000);
        let bet = 100_000;

        let result_a = compute_odds(pools.0, pools.1, pools.2, bet, 0);
        let result_b = compute_odds(pools.0, pools.1, pools.2, bet, 1);
        let result_draw = compute_odds(pools.0, pools.1, pools.2, bet, 2);

        assert!(result_a.is_ok() && result_b.is_ok() && result_draw.is_ok());
        
        let (shares_a, odds_a) = result_a.unwrap();
        let (shares_b, odds_b) = result_b.unwrap();
        let (shares_draw, odds_draw) = result_draw.unwrap();

        assert!(shares_a > 0 && shares_b > 0 && shares_draw > 0);
        assert!(odds_a > 0 && odds_b > 0 && odds_draw > 0);
        
        println!(
            "Side A: {} shares at {} bps | Side B: {} shares at {} bps | Draw: {} shares at {} bps",
            shares_a, odds_a, shares_b, odds_b, shares_draw, odds_draw
        );
    }

    #[test]
    fn test_compute_odds_unequal_pools() {
        // Imbalanced pools — betting on underdog should give better odds
        let pools_underdog = (10_000_000, 100_000, 100_000); // FighterA heavily favored
        let pools_favorite = (100_000, 10_000_000, 100_000); // FighterB heavily favored
        let bet = 100_000;

        let result_underdog = compute_odds(pools_underdog.0, pools_underdog.1, pools_underdog.2, bet, 1);
        let result_favorite = compute_odds(pools_favorite.0, pools_favorite.1, pools_favorite.2, bet, 1);

        assert!(result_underdog.is_ok() && result_favorite.is_ok());
        
        let (_, odds_underdog) = result_underdog.unwrap();
        let (_, odds_favorite) = result_favorite.unwrap();

        // Underdog position (side B in heavily-A-favored market) should have better odds
        assert!(
            odds_underdog > odds_favorite,
            "Underdog should offer better odds"
        );
        
        println!(
            "Underdog odds: {} bps vs Favorite odds: {} bps",
            odds_underdog, odds_favorite
        );
    }

    #[test]
    fn test_compute_odds_zero_pool() {
        let result = compute_odds(0, 1_000_000, 1_000_000, 100_000, 0);
        assert!(result.is_err());
    }

    #[test]
    fn test_compute_odds_zero_bet() {
        let result = compute_odds(1_000_000, 1_000_000, 1_000_000, 0, 0);
        assert!(result.is_err());
    }

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

    #[test]
    fn test_calc_max_trade() {
        assert_eq!(calc_max_trade(0, 1_000_000), 0);
        assert_eq!(calc_max_trade(1, 1_000_000), 0);
        assert_eq!(calc_max_trade(2, 1_000_000), 1);
        assert_eq!(calc_max_trade(1_000_000, 1_000_000), 999_999);
    }

    #[test]
    fn test_calc_claimable_lp_fees() {
        // No LP shares
        assert_eq!(calc_claimable_lp_fees(1_000_000, 0, 0), 0);

        // With fees and shares
        let claimable = calc_claimable_lp_fees(1_000_000, 500_000, 1_000_000);
        let expected = (1_000_000 - 500_000) * 1_000_000 / 1_000_000;
        assert_eq!(claimable, expected);
    }
}
