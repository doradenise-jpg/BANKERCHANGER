use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

#[test]
fn test_initialize_populates_storage() {
    let env = Env::default();
    let contract_id = env.register_contract(None, MarketFactory);
    let client = MarketFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracle_a = Address::generate(&env);
    let oracle_b = Address::generate(&env);
    let mut oracles = Vec::new(&env);
    oracles.push_back(oracle_a.clone());
    oracles.push_back(oracle_b.clone());

    client.initialize(&admin, &oracles, &250u32);

    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_oracles(), oracles);
    assert_eq!(client.get_default_fee_bps(), 250u32);
    assert_eq!(client.is_paused(), false);
    assert_eq!(client.get_state(), FactoryState::Active);
}

#[test]
fn test_initialize_empty_oracles() {
    let env = Env::default();
    let contract_id = env.register_contract(None, MarketFactory);
    let client = MarketFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracles: Vec<Address> = Vec::new(&env);

    client.initialize(&admin, &oracles, &100u32);

    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_oracles().len(), 0);
    assert_eq!(client.get_default_fee_bps(), 100u32);
    assert_eq!(client.is_paused(), false);
}

#[test]
fn test_initialize_twice_fails() {
    let env = Env::default();
    let contract_id = env.register_contract(None, MarketFactory);
    let client = MarketFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracles: Vec<Address> = Vec::new(&env);

    client.initialize(&admin, &oracles, &100u32);

    let result = client.try_initialize(&admin, &oracles, &100u32);
    assert_eq!(result, Err(Ok(FactoryError::AlreadyInitialized)));
}
