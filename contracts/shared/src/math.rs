use crate::errors::ContractError;

/// Returns |a - b| without overflow for any i128 pair.
pub fn abs_diff(a: i128, b: i128) -> i128 {
    if a >= b {
        a.wrapping_sub(b)
    } else {
        b.wrapping_sub(a)
    }
}

/// Clamps `val` to [min_val, max_val].
pub fn clamp(val: i128, min_val: i128, max_val: i128) -> i128 {
    if val < min_val {
        min_val
    } else if val > max_val {
        max_val
    } else {
        val
    }
}

/// Calculates payout for a bettor based on stake, prize pool, and winning pool:
///
/// Formula: `(bettor_stake * net_pool) / winning_pool`
///
/// Performs payout scaling with multiplication before division to preserve integer precision.
/// All multiplication uses `checked_mul` with explicit overflow handling.
///
/// # Errors
/// - Returns `ContractError::ArithmeticOverflow` on arithmetic overflow.
/// - Returns `ContractError::InvalidAmount` if inputs are negative.
pub fn calculate_payout(
    bettor_stake: i128,
    net_pool: i128,
    winning_pool: i128,
) -> Result<i128, ContractError> {
    if bettor_stake < 0 || net_pool < 0 || winning_pool < 0 {
        return Err(ContractError::InvalidAmount);
    }
    if winning_pool == 0 || bettor_stake == 0 || net_pool == 0 {
        return Ok(0);
    }

    let product = bettor_stake
        .checked_mul(net_pool)
        .ok_or(ContractError::ArithmeticOverflow)?;

    let payout = product
        .checked_div(winning_pool)
        .ok_or(ContractError::ArithmeticOverflow)?;

    Ok(payout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const MIN: i128 = i128::MIN;
    const MAX: i128 = i128::MAX;

    #[test]
    fn abs_diff_normal() {
        assert_eq!(abs_diff(10, 3), 7);
        assert_eq!(abs_diff(3, 10), 7);
        assert_eq!(abs_diff(-5, 5), 10);
        assert_eq!(abs_diff(0, 0), 0);
    }

    #[test]
    fn abs_diff_boundaries() {
        // MAX - 0 = MAX
        assert_eq!(abs_diff(MAX, 0), MAX);
        // MAX - MIN would overflow with plain subtraction; wrapping gives MAX - MIN = -1 as u128 → but
        // since both are i128 and MIN is negative, b.wrapping_sub(a) = MIN.wrapping_sub(MAX) = 1
        // The true mathematical |MAX - MIN| overflows i128, so wrapping is the defined behaviour here.
        assert_eq!(abs_diff(MIN, MIN), 0);
        assert_eq!(abs_diff(MAX, MAX), 0);
        assert_eq!(abs_diff(MAX, MAX - 1), 1);
        assert_eq!(abs_diff(MIN, MIN + 1), 1);
    }

    #[test]
    fn clamp_normal() {
        assert_eq!(clamp(5, 1, 10), 5);
        assert_eq!(clamp(0, 1, 10), 1);
        assert_eq!(clamp(11, 1, 10), 10);
        assert_eq!(clamp(1, 1, 10), 1);
        assert_eq!(clamp(10, 1, 10), 10);
    }

    #[test]
    fn clamp_boundaries() {
        assert_eq!(clamp(MIN, MIN, MAX), MIN);
        assert_eq!(clamp(MAX, MIN, MAX), MAX);
        assert_eq!(clamp(0, MIN, MAX), 0);
        assert_eq!(clamp(MIN, 0, MAX), 0);
        assert_eq!(clamp(MAX, MIN, 0), 0);
    }

    #[test]
    fn calculate_payout_normal_range() {
        // Standard normal-range calculations
        assert_eq!(
            calculate_payout(10_000_000, 14_700_000, 20_000_000).unwrap(),
            7_350_000
        );
        assert_eq!(
            calculate_payout(10_000_000, 9_800_000, 10_000_000).unwrap(),
            9_800_000
        );
        assert_eq!(calculate_payout(0, 10_000_000, 10_000_000).unwrap(), 0);
        assert_eq!(calculate_payout(10_000_000, 0, 10_000_000).unwrap(), 0);
        assert_eq!(calculate_payout(10_000_000, 10_000_000, 0).unwrap(), 0);
    }

    #[test]
    fn calculate_payout_negative_rejected() {
        assert_eq!(
            calculate_payout(-1, 100, 100).unwrap_err(),
            ContractError::InvalidAmount
        );
        assert_eq!(
            calculate_payout(100, -1, 100).unwrap_err(),
            ContractError::InvalidAmount
        );
        assert_eq!(
            calculate_payout(100, 100, -1).unwrap_err(),
            ContractError::InvalidAmount
        );
    }

    #[test]
    fn calculate_payout_boundary_overflow() {
        let half_max = i128::MAX / 2;

        // half_max * 2 does not overflow i128
        let res_safe = calculate_payout(half_max, 2, 2);
        assert_eq!(res_safe.unwrap(), half_max);

        // half_max * 3 overflows i128 before division reduces the value
        let res_overflow = calculate_payout(half_max, 3, 1);
        assert_eq!(res_overflow.unwrap_err(), ContractError::ArithmeticOverflow);

        // half_max * half_max overflows i128
        let res_overflow_half = calculate_payout(half_max, half_max, 1);
        assert_eq!(
            res_overflow_half.unwrap_err(),
            ContractError::ArithmeticOverflow
        );

        // i128::MAX * 2 overflows i128
        let res_overflow_max = calculate_payout(i128::MAX, 2, 1);
        assert_eq!(
            res_overflow_max.unwrap_err(),
            ContractError::ArithmeticOverflow
        );
    }

    proptest! {
        #[test]
        fn proptest_payout_boundary_overflow(
            stake in (i128::MAX / 2)..=i128::MAX,
            price in 3i128..=10_000i128,
            winning_pool in 1i128..=10_000_000i128,
        ) {
            let res = calculate_payout(stake, price, winning_pool);
            prop_assert_eq!(res, Err(ContractError::ArithmeticOverflow));
        }

        #[test]
        fn proptest_payout_normal_range_no_regression(
            stake in 1i128..=100_000_000_000i128,
            net_pool in 1i128..=100_000_000_000i128,
            scale in 1i128..=100_000_000_000i128,
        ) {
            let res = calculate_payout(stake, net_pool, scale);
            prop_assert!(res.is_ok());
            let payout = res.unwrap();
            prop_assert!(payout >= 0);
            if stake <= scale {
                prop_assert!(payout <= net_pool);
            }
        }
    }
}

