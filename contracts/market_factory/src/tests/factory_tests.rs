extern crate std;

use super::{init_factory, sample_fight, sample_market_config, setup};
use crate::{MarketClient, MARKET_COUNT, MARKET_MAP};
use boxmeout_shared::{
    errors::ContractError,
    types::{MarketState, MarketStatus, OptionalMarketTier, OptionalOracleRole, OptionalOutcome},
};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events, Ledger},
    Address, BytesN, Env, Map, String, Symbol, TryFromVal, Val, Vec,
};

#[contract]
struct ListedMarket;

#[contractimpl]
impl ListedMarket {
    pub fn get_state(env: Env) -> MarketState {
        MarketState {
            market_id: 0,
            fight: sample_fight(&env),
            config: sample_market_config(&env),
            status: MarketStatus::Open,
            outcome: OptionalOutcome::None,
            pool_a: 0,
            pool_b: 0,
            pool_draw: 0,
            total_pool: 0,
            resolved_at: 0,
            oracle_used: OptionalOracleRole::None,
            tier: OptionalMarketTier::None,
        }
    }

    pub fn get_market_status(_env: Env) -> MarketStatus {
        MarketStatus::Paused
    }
}

#[test]
fn list_markets_returns_newest_first_and_limits_registry_reads() {
    let (env, factory) = setup();
    init_factory(&env, &factory);
    assert!(factory.list_markets(&0, &100).is_empty());
    let market = env.register(ListedMarket, ());
    let unreadable = Address::generate(&env);
    let mut addresses = Map::new(&env);
    for id in 0..103u64 {
        addresses.set(id, market.clone());
    }
    addresses.set(101, unreadable);
    env.as_contract(&factory.address, || {
        env.storage().persistent().set(&MARKET_MAP, &addresses);
        env.storage().persistent().set(&MARKET_COUNT, &103u64);
    });

    assert!(factory.list_markets(&103, &1).is_empty());
    assert!(factory.list_markets(&u64::MAX, &1).is_empty());
    assert!(factory.list_markets(&0, &0).is_empty());
    assert!(factory.list_markets(&1, &1).is_empty());

    let page = factory.list_markets(&2, &u32::MAX);
    assert_eq!(page.len(), 100);
    assert_eq!(page.last().unwrap().market_id, 1);
    let entry = page.first().unwrap();
    let fight = sample_fight(&env);
    assert_eq!(entry.market_id, 100);
    assert_eq!(entry.contract_address, market);
    assert_eq!(entry.fighter_a, fight.fighter_a);
    assert_eq!(entry.fighter_b, fight.fighter_b);
    assert_eq!(entry.weight_class, fight.weight_class);
    assert_eq!(entry.scheduled_at, fight.scheduled_at);
    assert_eq!(entry.status, MarketStatus::Paused);

    let first_page = factory.list_markets(&0, &3);
    assert_eq!(first_page.len(), 2);
    assert_eq!(first_page.first().unwrap().market_id, 102);
    assert_eq!(first_page.last().unwrap().market_id, 100);

    factory.pause_factory(&factory.get_admin(), &String::from_str(&env, "maintenance"));
    assert_eq!(factory.list_markets(&0, &3), first_page);
}

fn assert_factory_event(
    env: &Env,
    address: &Address,
    name: &str,
    admin: &Address,
    timestamp: u64,
    reason: &String,
) {
    let (emitter, topics, data): (Address, Vec<Val>, Val) = env.events().all().last().unwrap();
    assert_eq!(&emitter, address);
    assert_eq!(topics.len(), 2);
    assert_eq!(
        Symbol::try_from_val(env, &topics.get(0).unwrap()).unwrap(),
        Symbol::new(env, name),
    );
    assert_eq!(
        Address::try_from_val(env, &topics.get(1).unwrap()).unwrap(),
        *admin,
    );
    assert_eq!(
        <(u64, String)>::try_from_val(env, &data).unwrap(),
        (timestamp, reason.clone()),
    );
}

#[test]
fn pause_and_unpause_require_admin_and_emit_timestamped_reasons() {
    let (env, factory) = setup();
    init_factory(&env, &factory);
    let admin = factory.get_admin();
    let outsider = Address::generate(&env);
    let reason = String::from_str(&env, "maintenance");
    let resumption = String::from_str(&env, "maintenance complete");
    let fight = sample_fight(&env);
    let config = sample_market_config(&env);

    assert_eq!(
        factory.try_pause_factory(&outsider, &reason),
        Err(Ok(ContractError::NotAdmin))
    );
    assert!(!factory.is_paused());
    env.ledger().with_mut(|ledger| ledger.timestamp = 15);
    factory.pause_factory(&admin, &reason);
    assert_factory_event(&env, &factory.address, "FactoryPaused", &admin, 15, &reason);
    assert!(factory.is_paused());
    assert_eq!(
        factory.try_create_market(&outsider, &fight, &config, &None),
        Err(Ok(ContractError::FactoryPaused)),
    );

    assert_eq!(
        factory.try_unpause_factory(&outsider, &resumption),
        Err(Ok(ContractError::NotAdmin))
    );
    assert!(factory.is_paused());
    env.ledger().with_mut(|ledger| ledger.timestamp = 30);
    factory.unpause_factory(&admin, &resumption);
    assert_factory_event(
        &env,
        &factory.address,
        "FactoryUnpaused",
        &admin,
        30,
        &resumption,
    );
    assert!(!factory.is_paused());
    assert_eq!(
        factory.try_create_market(&outsider, &fight, &config, &None),
        Err(Ok(ContractError::WasmHashNotSet)),
    );
}

#[test]
#[ignore = "requires the release market WASM at MARKET_TEST_WASM"]
fn create_market_deploys_and_initializes_the_market_wasm() {
    let (env, factory) = setup();
    init_factory(&env, &factory);
    let wasm = std::fs::read(std::env::var("MARKET_TEST_WASM").unwrap()).unwrap();
    let hash = env.deployer().upload_contract_wasm(wasm.as_slice());
    let admin = factory.get_admin();
    let caller = Address::generate(&env);
    factory.update_market_wasm(&admin, &hash);
    let fight = sample_fight(&env);
    let mut config = sample_market_config(&env);
    config.tier = 10;

    let id = factory.create_market(&caller, &fight, &config, &Some(275));
    let (emitter, topics, data) = env.events().all().last().unwrap();
    assert_eq!(emitter, factory.address);
    assert_eq!(
        Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap(),
        Symbol::new(&env, "market_created"),
    );
    assert_eq!(
        u64::try_from_val(&env, &topics.get(1).unwrap()).unwrap(),
        id
    );
    let address = factory.get_market_address(&id);
    assert_eq!(
        <(Address, String)>::try_from_val(&env, &data).unwrap(),
        (address.clone(), fight.match_id.clone()),
    );
    let state = MarketClient::new(&env, &address).get_state();
    assert_eq!(id, 0);
    assert_eq!(factory.get_market_count(), 1);
    assert_eq!(factory.get_open_market_ids().first(), Some(id));
    assert_eq!(state.market_id, id);
    assert_eq!(state.fight, fight);
    assert_eq!(state.status, MarketStatus::Open);
    assert_eq!((state.pool_a, state.pool_b, state.pool_draw), (0, 0, 0));
    assert_eq!(state.config.fee_bps, 275);
    assert_eq!(
        state.tier,
        OptionalMarketTier::Some(boxmeout_shared::types::MarketTier::Tier10)
    );
    assert_eq!(
        factory
            .list_markets(&0, &1)
            .first()
            .unwrap()
            .contract_address,
        address
    );
}

#[test]
fn create_market_rejects_invalid_override_and_missing_treasury() {
    let (env, factory) = setup();
    init_factory(&env, &factory);
    let admin = factory.get_admin();
    let caller = Address::generate(&env);
    let mut config = sample_market_config(&env);
    let fight = sample_fight(&env);
    for invalid_share in [0, 10_001] {
        config.max_bet_share_bps = invalid_share;
        assert_eq!(
            factory.try_create_market(&caller, &fight, &config, &None),
            Err(Ok(ContractError::InvalidMarketParameters)),
        );
    }
    config.max_bet_share_bps = 10_000;
    assert_eq!(
        factory.try_create_market(&caller, &fight, &config, &Some(1001)),
        Err(Ok(ContractError::InvalidMarketParameters)),
    );
    factory.update_market_wasm(&admin, &BytesN::from_array(&env, &[1; 32]));
    env.as_contract(&factory.address, || {
        env.storage().persistent().remove(&crate::TREASURY)
    });
    assert_eq!(
        factory.try_create_market(&caller, &fight, &config, &Some(1000)),
        Err(Ok(ContractError::NotFactory)),
    );
}
