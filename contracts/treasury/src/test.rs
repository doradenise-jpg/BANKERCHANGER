use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env, Symbol, Vec,
};
use boxmeout_shared::errors::ContractError;
use boxmeout_shared::types::FeeTier;
use crate::{Treasury, TreasuryClient};

fn setup_treasury(env: &Env) -> (TreasuryClient<'static>, Address, Address) {
    env.mock_all_auths();
    let contract_id = env.register_contract(None, Treasury);
    let client = TreasuryClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let token = env.register_stellar_asset_contract(admin.clone());
    let factory = Address::generate(env);
    client.initialize(&admin, &token, &factory, &1_000_000_000_i128);
    (client, admin, token)
}

#[test]
fn test_default_fee_tiers_initialized() {
    let env = Env::default();
    let (client, _admin, _token) = setup_treasury(&env);

    let tiers = client.get_fee_tiers();
    assert_eq!(tiers.len(), 3);
    assert_eq!(tiers.get(0).unwrap().volume_threshold, 100_000_000);
    assert_eq!(tiers.get(0).unwrap().fee_bps, 200);
    assert_eq!(tiers.get(1).unwrap().volume_threshold, 500_000_000);
    assert_eq!(tiers.get(1).unwrap().fee_bps, 150);
    assert_eq!(tiers.get(2).unwrap().volume_threshold, u64::MAX);
    assert_eq!(tiers.get(2).unwrap().fee_bps, 100);
}

#[test]
fn test_calculate_fee_across_default_tiers() {
    let env = Env::default();
    let (client, _admin, _token) = setup_treasury(&env);

    // Tier 1: market_total_volume <= 100_000_000 -> 200 bps (2%)
    // Bet: 10_000_000 stroops (1 XLM) -> fee = 200_000 stroops (0.02 XLM)
    let fee1 = client.calculate_fee(&0, &10_000_000);
    assert_eq!(fee1, 200_000);

    let fee1_boundary = client.calculate_fee(&100_000_000, &10_000_000);
    assert_eq!(fee1_boundary, 200_000);

    // Tier 2: 100_000_001 <= market_total_volume <= 500_000_000 -> 150 bps (1.5%)
    // Bet: 10_000_000 stroops -> fee = 150_000 stroops (0.015 XLM)
    let fee2_start = client.calculate_fee(&100_000_001, &10_000_000);
    assert_eq!(fee2_start, 150_000);

    let fee2_boundary = client.calculate_fee(&500_000_000, &10_000_000);
    assert_eq!(fee2_boundary, 150_000);

    // Tier 3: market_total_volume > 500_000_000 -> 100 bps (1%)
    // Bet: 10_000_000 stroops -> fee = 100_000 stroops (0.01 XLM)
    let fee3_start = client.calculate_fee(&500_000_001, &10_000_000);
    assert_eq!(fee3_start, 100_000);

    let fee3_high = client.calculate_fee(&10_000_000_000, &10_000_000);
    assert_eq!(fee3_high, 100_000);
}

#[test]
fn test_calculate_fee_edge_cases() {
    let env = Env::default();
    let (client, _admin, _token) = setup_treasury(&env);

    // Zero bet amount -> 0 fee
    assert_eq!(client.calculate_fee(&50_000_000, &0), 0);

    // Small bet amount (precision truncation)
    // 50 stroops at 200 bps (2%) = 1 stroop
    assert_eq!(client.calculate_fee(&0, &50), 1);
    // 40 stroops at 200 bps (2%) = 0 stroops (truncates safely)
    assert_eq!(client.calculate_fee(&0, &40), 0);

    // Large volume & large bet without overflow
    let large_bet = 1_000_000_000_000u64; // 100,000 XLM
    let fee_large = client.calculate_fee(&u64::MAX, &large_bet);
    assert_eq!(fee_large, 10_000_000_000u64); // 1,000 XLM (1%)
}

#[test]
fn test_admin_can_update_fee_tiers() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let mut custom_tiers = Vec::<FeeTier>::new(&env);
    custom_tiers.push_back(FeeTier { volume_threshold: 1_000_000, fee_bps: 300 }); // 3%
    custom_tiers.push_back(FeeTier { volume_threshold: 5_000_000, fee_bps: 200 }); // 2%
    custom_tiers.push_back(FeeTier { volume_threshold: 10_000_000, fee_bps: 50 }); // 0.5%

    client.set_fee_tiers(&admin, &custom_tiers);

    let updated = client.get_fee_tiers();
    assert_eq!(updated.len(), 3);
    assert_eq!(updated.get(0).unwrap().volume_threshold, 1_000_000);
    assert_eq!(updated.get(0).unwrap().fee_bps, 300);
    assert_eq!(updated.get(1).unwrap().volume_threshold, 5_000_000);
    assert_eq!(updated.get(1).unwrap().fee_bps, 200);
    assert_eq!(updated.get(2).unwrap().volume_threshold, 10_000_000);
    assert_eq!(updated.get(2).unwrap().fee_bps, 50);

    // Verify new calculation with updated tiers
    let fee = client.calculate_fee(&500_000, &10_000); // 300 bps (3%)
    assert_eq!(fee, 300);

    let fee2 = client.calculate_fee(&2_000_000, &10_000); // 200 bps (2%)
    assert_eq!(fee2, 200);

    let fee3 = client.calculate_fee(&8_000_000, &10_000); // 50 bps (0.5%)
    assert_eq!(fee3, 50);

    // Beyond highest threshold falls back to last tier (50 bps)
    let fee4 = client.calculate_fee(&20_000_000, &10_000);
    assert_eq!(fee4, 50);
}

#[test]
fn test_set_fee_tiers_emits_event() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let mut custom_tiers = Vec::<FeeTier>::new(&env);
    custom_tiers.push_back(FeeTier { volume_threshold: 10_000_000, fee_bps: 100 });

    client.set_fee_tiers(&admin, &custom_tiers);

    let events = env.events().all();
    let last = events.last().unwrap();
    let topic_sym: Symbol =
        soroban_sdk::TryFromVal::try_from_val(&env, &last.1.get(0).unwrap()).unwrap();
    assert_eq!(topic_sym, Symbol::new(&env, "fee_tiers_updated"));
    let (ev_admin, ev_count): (Address, u32) =
        soroban_sdk::TryFromVal::try_from_val(&env, &last.2).unwrap();
    assert_eq!(ev_admin, admin);
    assert_eq!(ev_count, 1);
}

#[test]
fn test_non_admin_cannot_update_fee_tiers() {
    let env = Env::default();
    let (client, _admin, _token) = setup_treasury(&env);
    let non_admin = Address::generate(&env);

    let mut custom_tiers = Vec::<FeeTier>::new(&env);
    custom_tiers.push_back(FeeTier { volume_threshold: 10_000_000, fee_bps: 100 });

    let result = client.try_set_fee_tiers(&non_admin, &custom_tiers);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::Unauthorized));
}

#[test]
fn test_set_empty_fee_tiers_fails() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let empty_tiers = Vec::<FeeTier>::new(&env);
    let result = client.try_set_fee_tiers(&admin, &empty_tiers);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::InvalidAmount));
}

#[test]
fn test_set_fee_tiers_with_excessive_bps_fails() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let mut invalid_tiers = Vec::<FeeTier>::new(&env);
    invalid_tiers.push_back(FeeTier { volume_threshold: 10_000_000, fee_bps: 10_001 }); // > 100%

    let result = client.try_set_fee_tiers(&admin, &invalid_tiers);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::InvalidAmount));
}

// ── Issue #19 — Minimum Reserve Tests ─────────────────────────────────────────

/// Helper that sets up treasury, mints tokens to a market, and deposits fees.
/// Returns (env, client, admin, market, token).
fn funded_treasury(
    fund: i128,
) -> (Env, TreasuryClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, Treasury);
    let client = TreasuryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(admin.clone());
    let factory = Address::generate(&env);
    let market = Address::generate(&env);
    // Initialize with a large per-tx withdrawal limit so it does not interfere.
    client.initialize(&admin, &token_addr, &factory, &1_000_000_000_000_i128);
    client.approve_market(&admin, &market);
    soroban_sdk::token::StellarAssetClient::new(&env, &token_addr).mint(&market, &fund);
    client.deposit_fees(&market, &token_addr, &fund);
    (env, client, admin, market, token_addr)
}

#[test]
fn test_withdraw_below_reserve_fails() {
    // Treasury has 500 XLM; reserve is 100 XLM (default = 1_000_000_000 stroops).
    // Trying to withdraw 401 XLM should fail (500 - 401 = 99 < 100).
    let fund: i128 = 5_000_000_000; // 500 XLM
    let (env, client, admin, _market, token) = funded_treasury(fund);

    // Set reserve to 100 XLM explicitly.
    client.set_minimum_reserve(&admin, &1_000_000_000_i128);

    let dest = Address::generate(&env);
    // 401 XLM = 4_010_000_000 stroops; leaves 990_000_000 < 1_000_000_000
    let result = client.try_withdraw_fees(&admin, &token, &4_010_000_000_i128, &dest);
    assert!(
        result.is_err(),
        "withdrawal leaving balance below reserve should fail"
    );
    assert_eq!(
        result.unwrap_err(),
        Ok(ContractError::ReserveFloorBreached)
    );
}

#[test]
fn test_withdraw_leaving_exactly_reserve_succeeds() {
    // Treasury has 500 XLM; reserve is 100 XLM.
    // Withdrawing exactly 400 XLM leaves balance == reserve — should succeed.
    let fund: i128 = 5_000_000_000; // 500 XLM
    let (env, client, admin, _market, token) = funded_treasury(fund);

    client.set_minimum_reserve(&admin, &1_000_000_000_i128); // 100 XLM

    let dest = Address::generate(&env);
    // 400 XLM = 4_000_000_000 stroops; leaves exactly 1_000_000_000 == reserve
    client.withdraw_fees(&admin, &token, &4_000_000_000_i128, &dest);
    assert_eq!(
        client.get_accumulated_fees(&token),
        1_000_000_000_i128,
        "balance after withdrawal should equal the reserve"
    );
}

#[test]
fn competing_withdrawals_cannot_both_consume_reserved_fees() {
    let (env, client, admin, _market, token) = funded_treasury(5_000_000_000);
    client.set_minimum_reserve(&admin, &1_000_000_000);
    let first_destination = Address::generate(&env);
    let second_destination = Address::generate(&env);

    // Model two withdrawals submitted against the same starting balance. Once
    // the first reserves and transfers its amount, the second must re-check the
    // updated accounting before it can pass the reserve floor.
    client.withdraw_fees(&admin, &token, &3_000_000_000, &first_destination);
    let second = client.try_withdraw_fees(&admin, &token, &1_100_000_000, &second_destination);
    assert_eq!(second.unwrap_err(), Ok(ContractError::ReserveFloorBreached));
    assert_eq!(client.get_accumulated_fees(&token), 2_000_000_000);
}

#[test]
fn test_admin_can_update_minimum_reserve() {
    let (env, client, admin, _market, token) = funded_treasury(5_000_000_000);
    // Default reserve is 1_000_000_000 (100 XLM).
    assert_eq!(client.get_minimum_reserve(), 1_000_000_000_i128);

    // Admin sets reserve to 50 XLM.
    client.set_minimum_reserve(&admin, &500_000_000_i128);
    assert_eq!(client.get_minimum_reserve(), 500_000_000_i128);
}

#[test]
fn test_non_admin_cannot_set_minimum_reserve() {
    let (env, client, _admin, _market, _token) = funded_treasury(5_000_000_000);
    let non_admin = Address::generate(&env);
    let result = client.try_set_minimum_reserve(&non_admin, &0_i128);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::Unauthorized));
}

#[test]
fn test_set_minimum_reserve_to_zero_disables_check() {
    // With reserve = 0 the admin should be able to withdraw everything.
    let fund: i128 = 5_000_000_000; // 500 XLM
    let (env, client, admin, _market, token) = funded_treasury(fund);

    client.set_minimum_reserve(&admin, &0_i128);

    let dest = Address::generate(&env);
    // Withdraw almost everything (leave 1 XLM for MIN_WITHDRAWAL check to pass)
    client.withdraw_fees(&admin, &token, &4_990_000_000_i128, &dest);
    assert_eq!(client.get_accumulated_fees(&token), 10_000_000_i128);
}

// ── Issue #856 — Fee Distribution Split BPS Validation Tests ──────────────────

use boxmeout_shared::types::FeeDistributionSplit;

#[test]
fn test_valid_fee_distribution_sums_to_10000_accepted() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let mut splits = Vec::<FeeDistributionSplit>::new(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    splits.push_back(FeeDistributionSplit { recipient: a.clone(), share_bps: 7_000 });
    splits.push_back(FeeDistributionSplit { recipient: b.clone(), share_bps: 3_000 });

    let result = client.try_set_fee_distribution(&admin, &splits);
    assert!(result.is_ok(), "valid 10000 BPS split should succeed");

    let stored = client.get_fee_distribution();
    assert_eq!(stored.len(), 2);
    assert_eq!(stored.get(0).unwrap().share_bps, 7_000);
    assert_eq!(stored.get(1).unwrap().share_bps, 3_000);
}

#[test]
fn test_fee_distribution_sum_less_than_10000_rejected() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let mut splits = Vec::<FeeDistributionSplit>::new(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    splits.push_back(FeeDistributionSplit { recipient: a, share_bps: 5_000 });
    splits.push_back(FeeDistributionSplit { recipient: b, share_bps: 4_999 }); // sum = 9999

    let result = client.try_set_fee_distribution(&admin, &splits);
    assert!(result.is_err(), "split summing to 9999 BPS must be rejected");
    assert_eq!(result.unwrap_err(), Ok(ContractError::InvalidFeeSplit));
}

#[test]
fn test_fee_distribution_sum_greater_than_10000_rejected() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let mut splits = Vec::<FeeDistributionSplit>::new(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    splits.push_back(FeeDistributionSplit { recipient: a, share_bps: 5_000 });
    splits.push_back(FeeDistributionSplit { recipient: b, share_bps: 5_001 }); // sum = 10001

    let result = client.try_set_fee_distribution(&admin, &splits);
    assert!(result.is_err(), "split summing to 10001 BPS must be rejected");
    assert_eq!(result.unwrap_err(), Ok(ContractError::InvalidFeeSplit));
}

#[test]
fn test_fee_distribution_empty_splits_rejected() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let empty_splits = Vec::<FeeDistributionSplit>::new(&env);
    let result = client.try_set_fee_distribution(&admin, &empty_splits);
    assert!(result.is_err(), "empty split list must be rejected");
    assert_eq!(result.unwrap_err(), Ok(ContractError::InvalidFeeSplit));
}

#[test]
fn test_fee_distribution_zero_share_entry_rejected() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let mut splits = Vec::<FeeDistributionSplit>::new(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    splits.push_back(FeeDistributionSplit { recipient: a, share_bps: 10_000 });
    splits.push_back(FeeDistributionSplit { recipient: b, share_bps: 0 }); // zero share

    let result = client.try_set_fee_distribution(&admin, &splits);
    assert!(result.is_err(), "zero-share entry must be rejected");
    assert_eq!(result.unwrap_err(), Ok(ContractError::InvalidFeeSplit));
}

#[test]
fn test_fee_distribution_non_admin_rejected() {
    let env = Env::default();
    let (client, _admin, _token) = setup_treasury(&env);
    let non_admin = Address::generate(&env);

    let mut splits = Vec::<FeeDistributionSplit>::new(&env);
    let a = Address::generate(&env);
    splits.push_back(FeeDistributionSplit { recipient: a, share_bps: 10_000 });

    let result = client.try_set_fee_distribution(&non_admin, &splits);
    assert!(result.is_err(), "non-admin must not be able to set fee distribution");
    assert_eq!(result.unwrap_err(), Ok(ContractError::Unauthorized));
}

#[test]
fn test_fee_distribution_single_recipient_10000_accepted() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let mut splits = Vec::<FeeDistributionSplit>::new(&env);
    let a = Address::generate(&env);
    splits.push_back(FeeDistributionSplit { recipient: a.clone(), share_bps: 10_000 });

    let result = client.try_set_fee_distribution(&admin, &splits);
    assert!(result.is_ok(), "single recipient with 10000 BPS should succeed");

    let stored = client.get_fee_distribution();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored.get(0).unwrap().share_bps, 10_000);
}

#[test]
fn test_get_fee_distribution_returns_empty_when_unset() {
    let env = Env::default();
    let (client, _admin, _token) = setup_treasury(&env);

    let splits = client.get_fee_distribution();
    assert_eq!(splits.len(), 0, "unset distribution should return empty vec");
}

#[test]
fn test_fee_distribution_can_be_overwritten() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let mut splits_v1 = Vec::<FeeDistributionSplit>::new(&env);
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    splits_v1.push_back(FeeDistributionSplit { recipient: a.clone(), share_bps: 6_000 });
    splits_v1.push_back(FeeDistributionSplit { recipient: b.clone(), share_bps: 4_000 });
    client.set_fee_distribution(&admin, &splits_v1);

    // Overwrite with three-way split
    let mut splits_v2 = Vec::<FeeDistributionSplit>::new(&env);
    let c = Address::generate(&env);
    splits_v2.push_back(FeeDistributionSplit { recipient: a.clone(), share_bps: 5_000 });
    splits_v2.push_back(FeeDistributionSplit { recipient: b.clone(), share_bps: 3_000 });
    splits_v2.push_back(FeeDistributionSplit { recipient: c.clone(), share_bps: 2_000 });
    client.set_fee_distribution(&admin, &splits_v2);

    let stored = client.get_fee_distribution();
    assert_eq!(stored.len(), 3);
    assert_eq!(stored.get(2).unwrap().share_bps, 2_000);
}
