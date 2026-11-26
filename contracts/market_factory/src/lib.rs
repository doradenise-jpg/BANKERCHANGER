#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum FactoryState {
    Uninitialized = 0,
    Active = 1,
    Paused = 2,
}

#[contracterror]
#[repr(u32)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FactoryError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidFee = 3,
}

const ADMIN: &str = "ADMIN";
const ORACLE_WHITELIST: &str = "ORACLE_WHITELIST";
const DEFAULT_FEE_BPS: &str = "DEFAULT_FEE_BPS";
const PAUSED: &str = "PAUSED";
const STATE: &str = "STATE";

const MAX_FEE_BPS: u32 = 10_000;

#[contract]
pub struct MarketFactory;

#[contractimpl]
impl MarketFactory {
    pub fn initialize(
        env: Env,
        admin: Address,
        oracles: Vec<Address>,
        default_fee_bps: u32,
    ) -> Result<(), FactoryError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(FactoryError::AlreadyInitialized);
        }
        if default_fee_bps > MAX_FEE_BPS {
            return Err(FactoryError::InvalidFee);
        }

        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&ORACLE_WHITELIST, &oracles);
        env.storage().instance().set(&DEFAULT_FEE_BPS, &default_fee_bps);
        env.storage().instance().set(&PAUSED, &false);
        env.storage().instance().set(&STATE, &FactoryState::Active);

        Ok(())
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&ADMIN).unwrap()
    }

    pub fn oracles(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&ORACLE_WHITELIST)
            .unwrap_or(Vec::new(&env))
    }

    pub fn default_fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DEFAULT_FEE_BPS).unwrap()
    }

    pub fn paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED).unwrap_or(false)
    }

    pub fn state(env: Env) -> FactoryState {
        env.storage()
            .instance()
            .get(&STATE)
            .unwrap_or(FactoryState::Uninitialized)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    #[test]
    fn initialize_populates_storage() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MarketFactory);
        let client = MarketFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        let mut oracles = Vec::new(&env);
        oracles.push_back(oracle.clone());

        client.initialize(&admin, &oracles, &250u32);

        assert_eq!(client.admin(), admin);
        assert_eq!(client.oracles(), oracles);
        assert_eq!(client.default_fee_bps(), 250u32);
        assert_eq!(client.paused(), false);
        assert_eq!(client.state(), FactoryState::Active);
    }

    #[test]
    fn initialize_allows_empty_oracles() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MarketFactory);
        let client = MarketFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let oracles = Vec::new(&env);

        client.initialize(&admin, &oracles, &100u32);

        assert_eq!(client.oracles().len(), 0);
        assert_eq!(client.default_fee_bps(), 100u32);
    }

    #[test]
    fn second_initialize_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MarketFactory);
        let client = MarketFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let oracles = Vec::new(&env);

        client.initialize(&admin, &oracles, &100u32);
        let result = client.try_initialize(&admin, &oracles, &100u32);

        assert_eq!(result, Err(Ok(FactoryError::AlreadyInitialized)));
    }
}
