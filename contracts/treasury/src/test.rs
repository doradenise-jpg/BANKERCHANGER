use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env, Symbol, Vec,
};
use boxmeout_shared::errors::ContractError;
use boxmeout_shared::types::FeeTier;
use crate::{Treasury, TreasuryClient};

fn setup_treasury(env: &Env) -> (TreasuryClient<'static>, Address, Address) {
    env.mock_all_auths();
    let contract_id = env.register(Treasury, ());
    let client = TreasuryClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
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
    let contract_id = env.register(Treasury, ());
    let client = TreasuryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let factory = Address::generate(&env);
    let market = Address::generate(&env);
    // Initialize with a large per-tx withdrawal limit so it does not interfere.
    client.initialize(&admin, &token_addr, &factory, &1_000_000_000_000_i128);
    client.approve_market(&admin, &market);
    soroban_sdk::token::StellarAssetClient::new(&env, &token_addr).mint(&market, &fund);
    client.deposit_fees(&market, &token_addr, &fund);
    (env, client, admin, market, token_addr)
}

// ── Issue #1041 — Treasury unit test suite ────────────────────────────────────

#[test]
fn test_initialize_sets_state() {
    let env = Env::default();
    let (client, admin, token) = setup_treasury(&env);

    let state = client.get_treasury_state();
    assert_eq!(state.admin, admin);
    assert_eq!(state.token, token);
    assert_eq!(state.total_balance, 0);
    assert_eq!(state.total_fees_collected, 0);
}

#[test]
fn test_initialize_twice_fails() {
    let env = Env::default();
    let (client, admin, token) = setup_treasury(&env);
    let factory = Address::generate(&env);

    let result = client.try_initialize(&admin, &token, &factory, &1_000_000_000_i128);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::AlreadyInitialized));
}

#[test]
fn test_deposit_fee_valid_updates_balance() {
    let env = Env::default();
    let (client, admin, token) = setup_treasury(&env);
    let market = Address::generate(&env);
    client.approve_market(&admin, &market);

    let amount = 5_000_000_i128;
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&market, &amount);
    client.deposit_fees(&market, &token, &amount);

    let state = client.get_treasury_state();
    assert_eq!(state.total_balance, amount);
    assert_eq!(state.total_fees_collected, amount);

    // Second deposit accumulates consistently.
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&market, &amount);
    client.deposit_fees(&market, &token, &amount);

    let state2 = client.get_treasury_state();
    assert_eq!(state2.total_balance, amount * 2);
    assert_eq!(state2.total_fees_collected, amount * 2);
}

#[test]
fn test_deposit_fee_invalid_amount_fails() {
    let env = Env::default();
    let (client, admin, token) = setup_treasury(&env);
    let market = Address::generate(&env);
    client.approve_market(&admin, &market);

    let result = client.try_deposit_fees(&market, &token, &0_i128);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::InvalidAmount));

    let result_neg = client.try_deposit_fees(&market, &token, &-1_i128);
    assert!(result_neg.is_err());
    assert_eq!(result_neg.unwrap_err(), Ok(ContractError::InvalidAmount));
}

#[test]
fn test_deposit_fee_unapproved_market_fails() {
    let env = Env::default();
    let (client, _admin, token) = setup_treasury(&env);
    let market = Address::generate(&env);

    let amount = 1_000_000_i128;
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&market, &amount);
    let result = client.try_deposit_fees(&market, &token, &amount);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::Unauthorized));
}

#[test]
fn test_withdraw_fees_admin_succeeds() {
    let env = Env::default();
    let (client, admin, token) = setup_treasury(&env);
    let market = Address::generate(&env);
    client.approve_market(&admin, &market);

    let amount = 10_000_000_i128;
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&market, &amount);
    client.deposit_fees(&market, &token, &amount);

    let recipient = Address::generate(&env);
    let withdraw_amount = 4_000_000_i128;
    client.withdraw_fees(&admin, &recipient, &withdraw_amount);

    let state = client.get_treasury_state();
    assert_eq!(state.total_balance, amount - withdraw_amount);
    // Fees collected is cumulative and unaffected by withdrawals.
    assert_eq!(state.total_fees_collected, amount);

    let token_client = soroban_sdk::token::TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&recipient), withdraw_amount);
}

#[test]
fn test_withdraw_fees_non_admin_fails() {
    let env = Env::default();
    let (client, admin, token) = setup_treasury(&env);
    let market = Address::generate(&env);
    client.approve_market(&admin, &market);

    let amount = 10_000_000_i128;
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&market, &amount);
    client.deposit_fees(&market, &token, &amount);

    let non_admin = Address::generate(&env);
    let recipient = Address::generate(&env);
    let result = client.try_withdraw_fees(&non_admin, &recipient, &1_000_000_i128);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::Unauthorized));

    // Balance unchanged after failed withdrawal.
    let state = client.get_treasury_state();
    assert_eq!(state.total_balance, amount);
}

#[test]
fn test_withdraw_fees_invalid_amount_fails() {
    let env = Env::default();
    let (client, admin, token) = setup_treasury(&env);
    let market = Address::generate(&env);
    client.approve_market(&admin, &market);

    let amount = 10_000_000_i128;
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&market, &amount);
    client.deposit_fees(&market, &token, &amount);

    let recipient = Address::generate(&env);
    let result = client.try_withdraw_fees(&admin, &recipient, &0_i128);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::InvalidAmount));
}

#[test]
fn test_withdraw_fees_exceeding_balance_fails() {
    let env = Env::default();
    let (client, admin, token) = setup_treasury(&env);
    let market = Address::generate(&env);
    client.approve_market(&admin, &market);

    let amount = 10_000_000_i128;
    soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&market, &amount);
    client.deposit_fees(&market, &token, &amount);

    let recipient = Address::generate(&env);
    let result = client.try_withdraw_fees(&admin, &recipient, &(amount + 1));
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::InsufficientBalance));

    let state = client.get_treasury_state();
    assert_eq!(state.total_balance, amount);
}

#[test]
fn test_balance_tracking_multiple_markets() {
    let env = Env::default();
    let (client, admin, token) = setup_treasury(&env);
    let market_a = Address::generate(&env);
    let market_b = Address::generate(&env);
    client.approve_market(&admin, &market_a);
    client.approve_market(&admin, &market_b);

    let token_client = soroban_sdk::token::StellarAssetClient::new(&env, &token);
    token_client.mint(&market_a, &3_000_000_i128);
    token_client.mint(&market_b, &7_000_000_i128);
    client.deposit_fees(&market_a, &token, &3_000_000_i128);
    client.deposit_fees(&market_b, &token, &7_000_000_i128);

    let state = client.get_treasury_state();
    assert_eq!(state.total_balance, 10_000_000);
    assert_eq!(state.total_fees_collected, 10_000_000);

    let recipient = Address::generate(&env);
    client.withdraw_fees(&admin, &recipient, &5_000_000_i128);

    let state2 = client.get_treasury_state();
    assert_eq!(state2.total_balance, 5_000_000);
    assert_eq!(state2.total_fees_collected, 10_000_000);
}

// ── Issue #1018 — Contract Versioning & Upgrade Tests ─────────────────────────

#[test]
fn test_contract_version_returns_current_version() {
    let env = Env::default();
    let (client, _admin, _token) = setup_treasury(&env);

    assert_eq!(client.contract_version(), crate::CONTRACT_VERSION);
}

#[test]
fn test_upgrade_contract_persists_metadata() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let new_wasm_hash = soroban_sdk::BytesN::from_array(&env, &[7u8; 32]);

    client.upgrade_contract(&admin, &new_wasm_hash);

    // Version is bumped and the upgrader is recorded.
    assert_eq!(client.contract_version(), crate::CONTRACT_VERSION + 1);

    let metadata = client.get_contract_metadata();
    assert_eq!(metadata.version, crate::CONTRACT_VERSION + 1);
    assert_eq!(metadata.upgrader_address, admin);
    assert!(metadata.deployed_at > 0);

    // Metadata survives a subsequent upgrade and tracks the latest upgrader.
    let second_upgrader = Address::generate(&env);
    let second_hash = soroban_sdk::BytesN::from_array(&env, &[9u8; 32]);
    client.upgrade_contract(&second_upgrader, &second_hash);

    let metadata_after = client.get_contract_metadata();
    assert_eq!(metadata_after.version, crate::CONTRACT_VERSION + 2);
    assert_eq!(metadata_after.upgrader_address, second_upgrader);
    assert_eq!(client.contract_version(), crate::CONTRACT_VERSION + 2);
}

#[test]
fn test_upgrade_contract_rejects_invalid_hash() {
    let env = Env::default();
    let (client, admin, _token) = setup_treasury(&env);

    let zero_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
    let result = client.try_upgrade_contract(&admin, &zero_hash);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::InvalidAmount));

    // Version unchanged after a rejected upgrade.
    assert_eq!(client.contract_version(), crate::CONTRACT_VERSION);
}

#[test]
fn test_upgrade_contract_rejects_non_admin() {
    let env = Env::default();
    let (client, _admin, _token) = setup_treasury(&env);
    let non_admin = Address::generate(&env);

    let new_wasm_hash = soroban_sdk::BytesN::from_array(&env, &[3u8; 32]);
    let result = client.try_upgrade_contract(&non_admin, &new_wasm_hash);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), Ok(ContractError::Unauthorized));
}
