use boxmeout_market::{Market, MarketClient};
use boxmeout_shared::{
    event_parser::parse_market_cancelled_event,
    types::{BetSide, FightDetails, MarketConfig},
};
use boxmeout_treasury::{Treasury, TreasuryClient};
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger, LedgerInfo},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, String, Symbol, TryFromVal,
};

fn setup_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set(LedgerInfo {
        timestamp: 1_000,
        protocol_version: 22,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 1,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_311_520,
    });
    env
}

fn sample_fight(env: &Env) -> FightDetails {
    FightDetails {
        match_id: String::from_str(env, "FIGHT-001"),
        fighter_a: String::from_str(env, "Canelo"),
        fighter_b: String::from_str(env, "Bivol"),
        weight_class: String::from_str(env, "Light Heavyweight"),
        scheduled_at: 10_000,
        venue: String::from_str(env, "T-Mobile Arena"),
        title_fight: true,
    }
}

fn sample_config() -> MarketConfig {
    MarketConfig {
        min_bet_amount: 1_000_000,
        max_bet: 100_000_000_000,
        fee_bps: 200, // 2%
        lock_before_secs: 3600,
        resolution_window: 86400,
        tier: 0,
        dispute_cooldown_ledgers: 0,
    }
}

/// Issue #636 (#10): Fee Collection Routes Through Treasury Contract
/// Acceptance Criteria:
/// - [x] place_bet calls treasury.deposit(fee_amount) via cross-contract call
/// - [x] Treasury emits a FeeDeposited event
/// - [x] Test verifies treasury balance increases by exact fee amount
/// - [x] No direct token transfers to admin address from market contract
#[test]
fn test_fee_routing_to_treasury_on_place_bet() {
    let env = setup_env();

    let admin = Address::generate(&env);
    let factory = Address::generate(&env);
    let bettor = Address::generate(&env);

    // Deploy and setup token contract
    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_client = TokenClient::new(&env, &token_id.address());
    let stellar_client = StellarAssetClient::new(&env, &token_id.address());

    // Deploy and initialize Treasury contract
    let treasury_id = env.register(Treasury, ());
    let treasury_client = TreasuryClient::new(&env, &treasury_id);
    treasury_client.initialize(&admin, &token_id.address(), &factory, &100_000_000_000i128);
    std::println!("Events after treasury init: {}", env.events().all().len());

    // Deploy and initialize Market contract
    let market_id = env.register(Market, ());
    let market_client = MarketClient::new(&env, &market_id);
    market_client.initialize(
        &factory,
        &1u64,
        &sample_fight(&env),
        &sample_config(),
        &treasury_id,
        &0u32,
    );
    std::println!("Events after market init: {}", env.events().all().len());

    // Mint 10_000_000 stroops (1 XLM) to bettor
    let bet_amount = 10_000_000i128;
    stellar_client.mint(&bettor, &bet_amount);
    std::println!("Events after mint: {}", env.events().all().len());

    // Check balances before bet:
    assert_eq!(token_client.balance(&treasury_id), 0);
    assert_eq!(token_client.balance(&admin), 0);
    assert_eq!(token_client.balance(&bettor), bet_amount);

    // Bettor places a bet
    let bet_record = market_client.place_bet(
        &bettor,
        &BetSide::FighterA,
        &bet_amount,
        &token_id.address(),
        &0i128,
    );
    let events = env.events().all();
    assert_eq!(bet_record.amount, bet_amount);

    // Expected fee is 2% of 10_000_000 = 200_000 stroops
    let expected_fee = (bet_amount * 200) / 10_000;
    assert_eq!(expected_fee, 200_000i128);

    // 1. Verify treasury balance increases by EXACT fee amount
    assert_eq!(
        token_client.balance(&treasury_id),
        expected_fee,
        "Treasury balance must increase by exact fee amount"
    );

    // 2. Verify NO direct token transfers to admin address from market contract
    assert_eq!(
        token_client.balance(&admin),
        0,
        "Admin must NOT receive direct token transfers"
    );

    // 3. Verify Treasury accounting was updated via deposit cross-contract call
    assert_eq!(
        treasury_client.get_accumulated_fees(&token_id.address()),
        expected_fee,
        "Treasury internal fee accounting must reflect deposit"
    );

    // 4. Verify Treasury emitted FeeDeposited event
    let fee_deposit_topic = Symbol::new(&env, "fee_deposited");
    let mut found_fee_event = false;

    for event in events.iter() {
        if let Some(first_topic) = event.1.get(0) {
            if let Ok(sym) = Symbol::try_from_val(&env, &first_topic) {
                if sym == fee_deposit_topic {
                    found_fee_event = true;
                    // Event data is (market, token, amount)
                    let (_ev_market, ev_token, ev_amount): (Address, Address, i128) =
                        soroban_sdk::TryFromVal::try_from_val(&env, &event.2).unwrap();
                    assert_eq!(ev_token, token_id.address());
                    assert_eq!(ev_amount, expected_fee);
                    break;
                }
            }
        }
    }
    assert!(found_fee_event, "Treasury FeeDeposited event must be emitted");
}

/// Issue #637 (#11): Missing Event for Market Cancellation
/// Acceptance Criteria:
/// - [x] MarketCancelled { market_id, cancelled_by, reason } event added to events.rs
/// - [x] cancel_market function in market contract emits the event
/// - [x] Event parser in shared/src/event_parser.rs handles the new event type
/// - [x] Integration test verifies event is emitted and parseable
#[test]
fn test_cancel_market_emits_parseable_event() {
    let env = setup_env();

    let factory = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Deploy and initialize Market contract
    let market_id = env.register(Market, ());
    let market_client = MarketClient::new(&env, &market_id);
    market_client.initialize(
        &factory,
        &42u64,
        &sample_fight(&env),
        &sample_config(),
        &treasury,
        &0u32,
    );

    let cancel_reason = String::from_str(&env, "Fighter injured during warmup");

    // Cancel market as factory
    market_client.cancel_market(&factory, &cancel_reason);

    // Find and parse the MarketCancelled event
    let events = env.events().all();
    let mut parsed_cancel_event = None;

    for event in events.iter() {
        let (_contract_id, topics, data) = event;
        if let Ok(parsed) = parse_market_cancelled_event(&env, &topics, &data) {
            parsed_cancel_event = Some(parsed);
            break;
        }
    }

    assert!(
        parsed_cancel_event.is_some(),
        "MarketCancelled event must be emitted and parseable"
    );

    let parsed = parsed_cancel_event.unwrap();
    assert_eq!(parsed.market_id, 42u64);
    assert_eq!(parsed.cancelled_by, factory);
    assert_eq!(parsed.reason, cancel_reason);
}
