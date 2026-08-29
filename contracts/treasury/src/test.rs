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
