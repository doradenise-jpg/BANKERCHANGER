#![cfg(test)]
extern crate std;

use boxmeout_market::{Market, MarketClient, CLAIM_WINDOW_LEDGERS, EXPIRY_GRACE_PERIOD};
use boxmeout_shared::{
    errors::ContractError,
    types::{
        BetSide, FightDetails, MarketConfig, MarketState, MarketStatus, Outcome,
    },
};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::Client as TokenClient,
    token::StellarAssetClient,
    Address, Env, String,
};

fn sample_fight(env: &Env, scheduled_at: u64) -> FightDetails {
    FightDetails {
        match_id: String::from_str(env, "MATCH-001"),
        fighter_a: String::from_str(env, "Canelo"),
        fighter_b: String::from_str(env, "Bivol"),
        weight_class: String::from_str(env, "Light Heavyweight"),
        scheduled_at,
        venue: String::from_str(env, "T-Mobile Arena"),
        title_fight: true,
    }
}

fn sample_config() -> MarketConfig {
    MarketConfig {
        min_bet_amount: 1_000_000,
        max_bet: 100_000_000_000,
        fee_bps: 200,
        lock_before_secs: 3600,
        resolution_window: 86400,
        tier: 0,
        dispute_cooldown_ledgers: 720,
    }
}

fn setup_market(env: &Env, scheduled_at: u64) -> (MarketClient<'static>, Address, Address, Address, Address) {
    env.mock_all_auths();
    env.ledger().set(LedgerInfo {
        timestamp: 10_000,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 1,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_311_520,
    });

    let factory = Address::generate(env);
    let treasury = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract(token_admin);

    let contract_id = env.register(Market, ());
    let client = MarketClient::new(env, &contract_id);
    client.initialize(&factory, &1u64, &sample_fight(env, scheduled_at), &sample_config(), &treasury, &0u32);

    (client, contract_id, factory, treasury, token_id)
}

// =========================================================================
// ISSUE #649 / #23: Admin Cannot Pause Individual Markets
// =========================================================================

#[test]
fn test_pause_market_rejects_bets_and_unpause_restores() {
    let env = Env::default();
    let (client, _contract_id, factory, _treasury, token_id) = setup_market(&env, 100_000);
    let bettor = Address::generate(&env);
    let asset_client = StellarAssetClient::new(&env, &token_id);
    asset_client.mint(&bettor, &100_000_000i128);

    // Initial status is Open and unpaused
    assert_eq!(client.get_status(), MarketStatus::Open);
    assert_eq!(client.get_market_status(), MarketStatus::Open);
    assert_eq!(client.is_paused(), false);

    // Non-admin cannot pause
    let non_admin = Address::generate(&env);
    let non_admin_pause = client.try_pause(&non_admin);
    assert_eq!(non_admin_pause.unwrap_err(), Ok(ContractError::NotAdmin));

    // Admin pauses the market
    client.pause(&factory);

    // Status query reflects Paused
    assert_eq!(client.get_status(), MarketStatus::Paused);
    assert_eq!(client.get_market_status(), MarketStatus::Paused);
    assert_eq!(client.is_paused(), true);

    // Bets are rejected with ContractError::MarketPaused
    let bet_res = client.try_place_bet(&bettor, &BetSide::FighterA, &10_000_000i128, &token_id, &0i128);
    assert_eq!(bet_res.unwrap_err(), Ok(ContractError::MarketPaused));

    // Non-admin cannot unpause
    let non_admin_unpause = client.try_unpause(&non_admin);
    assert_eq!(non_admin_unpause.unwrap_err(), Ok(ContractError::NotAdmin));

    // Admin unpauses the market
    client.unpause(&factory);

    // Status restores to Open and betting succeeds
    assert_eq!(client.get_status(), MarketStatus::Open);
    assert_eq!(client.get_market_status(), MarketStatus::Open);
    assert_eq!(client.is_paused(), false);

    let bet = client.place_bet(&bettor, &BetSide::FighterA, &10_000_000i128, &token_id, &0i128);
    assert_eq!(bet.amount, 10_000_000i128);
}

// =========================================================================
// ISSUE #640 / #14: Expired Markets Not Automatically Refundable
// =========================================================================

#[test]
fn test_refund_expired_market_three_bettors() {
    let env = Env::default();
    let scheduled_at = 100_000u64;
    let (client, _contract_id, _factory, _treasury, token_id) = setup_market(&env, scheduled_at);

    let bettor1 = Address::generate(&env);
    let bettor2 = Address::generate(&env);
    let bettor3 = Address::generate(&env);
    let asset_client = StellarAssetClient::new(&env, &token_id);
    let token_client = TokenClient::new(&env, &token_id);

    asset_client.mint(&bettor1, &50_000_000i128);
    asset_client.mint(&bettor2, &50_000_000i128);
    asset_client.mint(&bettor3, &50_000_000i128);

    // 3 bettors place bets on different sides
    client.place_bet(&bettor1, &BetSide::FighterA, &10_000_000i128, &token_id, &0i128);
    client.place_bet(&bettor2, &BetSide::FighterB, &20_000_000i128, &token_id, &0i128);
    client.place_bet(&bettor3, &BetSide::Draw, &30_000_000i128, &token_id, &0i128);

    assert_eq!(token_client.balance(&bettor1), 40_000_000i128);
    assert_eq!(token_client.balance(&bettor2), 30_000_000i128);
    assert_eq!(token_client.balance(&bettor3), 20_000_000i128);

    // Attempting refund BEFORE expiry fails
    env.ledger().set_timestamp(scheduled_at + 10_000);
    let premature_res = client.try_refund_expired(&1u64);
    assert_eq!(premature_res.unwrap_err(), Ok(ContractError::InvalidMarketStatus));

    // Exactly at expiry threshold (scheduled_at + EXPIRY_GRACE_PERIOD) still fails
    env.ledger().set_timestamp(scheduled_at + EXPIRY_GRACE_PERIOD);
    let exact_res = client.try_refund_expired(&1u64);
    assert_eq!(exact_res.unwrap_err(), Ok(ContractError::InvalidMarketStatus));

    // Advance 1 second past expiry grace period
    env.ledger().set_timestamp(scheduled_at + EXPIRY_GRACE_PERIOD + 1);

    // Permissionless: any caller can trigger refund
    let refund_res = client.try_refund_expired(&1u64);
    assert!(refund_res.is_ok());

    // Verify all 3 bettors were refunded their exact stakes
    assert_eq!(token_client.balance(&bettor1), 50_000_000i128);
    assert_eq!(token_client.balance(&bettor2), 50_000_000i128);
    assert_eq!(token_client.balance(&bettor3), 50_000_000i128);

    // Market status is now Cancelled
    assert_eq!(client.get_status(), MarketStatus::Cancelled);

    // Calling refund again returns InvalidMarketStatus
    let second_call = client.try_refund_expired(&1u64);
    assert_eq!(second_call.unwrap_err(), Ok(ContractError::InvalidMarketStatus));
}

#[test]
fn test_refund_expired_rejects_resolved_market() {
    let env = Env::default();
    let scheduled_at = 100_000u64;
    let (client, contract_id, factory, _treasury, token_id) = setup_market(&env, scheduled_at);
    let bettor = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&bettor, &50_000_000i128);
    client.place_bet(&bettor, &BetSide::FighterA, &10_000_000i128, &token_id, &0i128);

    // Mark as Disputed and resolve
    env.as_contract(&contract_id, || {
        let mut state: MarketState = env.storage().persistent().get(&"STATE").unwrap();
        state.status = MarketStatus::Disputed;
        env.storage().persistent().set(&"STATE", &state);
    });
    client.resolve_dispute(&factory, &Outcome::FighterA);
    assert_eq!(client.get_status(), MarketStatus::Resolved);

    // Advance past expiration grace period
    env.ledger().set_timestamp(scheduled_at + EXPIRY_GRACE_PERIOD + 10_000);

    // Already resolved market cannot be refunded
    let res = client.try_refund_expired(&1u64);
    assert_eq!(res.unwrap_err(), Ok(ContractError::InvalidMarketStatus));
}

// =========================================================================
// ISSUE #641 / #15: Soroban State Rent Not Extended After Market Resolution
// =========================================================================

#[test]
fn test_market_calculate_fee_and_rent_accounting() {
    let total_pool = 100_000_000i128;
    let fee_bps = 200u32; // 2%
    let fee = Market::calculate_fee(total_pool, fee_bps).unwrap();
    assert_eq!(fee, 2_000_000i128);

    // Verify CLAIM_WINDOW_LEDGERS constant
    assert_eq!(CLAIM_WINDOW_LEDGERS, 2_000_000u32);
}

#[test]
fn test_resolution_extends_ttl_by_claim_window() {
    let env = Env::default();
    let (client, contract_id, factory, _treasury, token_id) = setup_market(&env, 100_000);
    let bettor = Address::generate(&env);
    StellarAssetClient::new(&env, &token_id).mint(&bettor, &50_000_000i128);
    client.place_bet(&bettor, &BetSide::FighterA, &10_000_000i128, &token_id, &0i128);

    // Resolve market
    env.as_contract(&contract_id, || {
        let mut state: MarketState = env.storage().persistent().get(&"STATE").unwrap();
        state.status = MarketStatus::Disputed;
        env.storage().persistent().set(&"STATE", &state);
    });
    client.resolve_dispute(&factory, &Outcome::FighterA);
    assert_eq!(client.get_status(), MarketStatus::Resolved);

    // Advance ledger far into the claim window (e.g. 100_000 ledgers)
    env.ledger().set(LedgerInfo {
        timestamp: 10_000 + 86_400 * 30,
        protocol_version: 22,
        sequence_number: 100_100,
        network_id: Default::default(),
        base_reserve: 1,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_311_520,
    });

    // Verify market state and bets persist without expiration
    let state = client.get_state();
    assert_eq!(state.status, MarketStatus::Resolved);
    assert_eq!(state.total_pool, 10_000_000i128);
}
