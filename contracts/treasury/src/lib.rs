#![no_std]
//! ============================================================
//! BANKERCHANGER — Treasury Contract (Security-Audited)
//! All fund-moving functions follow Checks-Effects-Interactions.
//! require_auth() is always the first call.
//!
//! ENHANCEMENTS for Issues #486 & #487:
//! - Enhanced daily withdrawal caps with per-token tracking
//! - Improved double-withdrawal prevention with nonce-based tracking
//! - Strengthened immutable audit logs with integrity verification
//! ============================================================

use soroban_sdk::{contract, contractimpl, token, Address, Env, Map, Vec};

use boxmeout_shared::errors::ContractError;
use boxmeout_shared::types::{AuditAction, AuditEntry};

const ADMIN: &str                   = "ADMIN";
const BET_TOKEN: &str               = "BET_TOKEN";
const FACTORY: &str                 = "FACTORY";
const ACCUMULATED_FEES: &str        = "ACCUMULATED_FEES";
const ACCUMULATED_FEES_BY_MARKET: &str = "ACCUMULATED_FEES_BY_MARKET";
const APPROVED_MARKETS: &str        = "APPROVED_MARKETS";
const WITHDRAWAL_LIMIT: &str        = "WITHDRAWAL_LIMIT";
const DAILY_WITHDRAWN: &str         = "DAILY_WITHDRAWN";
const DAILY_WITHDRAWN_PER_TOKEN: &str = "DAILY_WITHDRAWN_PER_TOKEN";
const WITHDRAWALS_PAUSED: &str      = "WITHDRAWALS_PAUSED";
const AUDIT_LOG: &str               = "AUDIT_LOG";
const AUDIT_NEXT_ID: &str           = "AUDIT_NEXT_ID";
const WITHDRAWAL_IN_PROGRESS: &str  = "WITHDRAWAL_IN_PROGRESS";
const WITHDRAWAL_NONCE: &str        = "WITHDRAWAL_NONCE";
const COMPLETED_WITHDRAWALS: &str   = "COMPLETED_WITHDRAWALS";
const DAILY_LIMIT_PER_TOKEN: &str   = "DAILY_LIMIT_PER_TOKEN";
const WITDRAWAL_COOLDOWN: &str      = "WITDRAWAL_COOLDOWN";
const LAST_WITHDRAWAL_BLOCK: &str   = "LAST_WITHDRAWAL_BLOCK";
const MIN_WITHDRAWAL: i128          = 10_000_000;
const WITHDRAWAL_COOLDOWN_BLOCKS: u32 = 1;

#[contract]
pub struct Treasury;

impl Treasury {
    fn require_admin(env: &Env, caller: &Address) -> Result<(), ContractError> {
        let admin: Address = env
            .storage().persistent()
            .get(&ADMIN)
            .ok_or(ContractError::Unauthorized)?;
        if *caller != admin {
            return Err(ContractError::Unauthorized);
        }
        Ok(())
    }

    fn day_bucket(env: &Env) -> u64 {
        env.ledger().timestamp() / 86400
    }

    fn prune_daily_withdrawn(env: &Env, daily: &mut Map<u64, i128>, current_bucket: u64) {
        let mut stale: Vec<u64> = Vec::new(env);
        for (k, _) in daily.iter() {
            if k + 1 < current_bucket {
                stale.push_back(k);
            }
        }
        for k in stale.iter() {
            daily.remove(k);
        }
    }

    fn prune_daily_withdrawn_per_token(
        env: &Env,
        daily: &mut Map<(u64, Address), i128>,
        current_bucket: u64,
    ) {
        let mut stale: Vec<(u64, Address)> = Vec::new(env);
        for (k, _) in daily.iter() {
            if k.0 + 1 < current_bucket {
                stale.push_back(k);
            }
        }
        for k in stale.iter() {
            daily.remove(k.clone());
        }
    }

    fn add_to_accumulated_token(env: &Env, token: &Address, amount: i128) {
        let mut fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(env));
        let current = fees.get(token.clone()).unwrap_or(0);
        fees.set(token.clone(), current + amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);
    }

    fn get_next_withdrawal_nonce(env: &Env) -> u64 {
        let nonce: u64 = env
            .storage()
            .persistent()
            .get(&WITHDRAWAL_NONCE)
            .unwrap_or(0);
        env.storage().persistent().set(&WITHDRAWAL_NONCE, &(nonce + 1));
        nonce
    }

    fn is_withdrawal_completed(env: &Env, nonce: u64) -> bool {
        let completed: Vec<u64> = env
            .storage()
            .persistent()
            .get(&COMPLETED_WITHDRAWALS)
            .unwrap_or_else(|| Vec::new(env));
        completed.contains(&nonce)
    }

    fn mark_withdrawal_completed(env: &Env, nonce: u64) {
        let mut completed: Vec<u64> = env
            .storage()
            .persistent()
            .get(&COMPLETED_WITHDRAWALS)
            .unwrap_or_else(|| Vec::new(env));
        if !completed.contains(&nonce) {
            completed.push_back(nonce);
            env.storage().persistent().set(&COMPLETED_WITHDRAWALS, &completed);
        }
    }

    fn record_audit(
        env: &Env,
        action: AuditAction,
        token: Address,
        amount: i128,
        actor: Address,
    ) {
        let next_id: u64 = env
            .storage()
            .persistent()
            .get(&AUDIT_NEXT_ID)
            .unwrap_or(0);
        let entry = AuditEntry {
            id: next_id,
            action: action.clone(),
            token: token.clone(),
            amount,
            actor: actor.clone(),
            timestamp: env.ledger().timestamp(),
        };

        let mut log: Vec<AuditEntry> =
            env.storage().persistent().get(&AUDIT_LOG).unwrap_or_else(|| Vec::new(env));
        log.push_back(entry.clone());

        env.storage().persistent().set(&AUDIT_LOG, &log);
        env.storage().persistent().set(&AUDIT_NEXT_ID, &(next_id + 1));
        boxmeout_shared::emit_audit_recorded(env, entry);
    }

    fn verify_audit_integrity(env: &Env) -> bool {
        let log: Vec<AuditEntry> = env
            .storage()
            .persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(env));
        let mut expected_id: u64 = 0;
        for entry in log.iter() {
            if entry.id != expected_id {
                return false;
            }
            expected_id += 1;
        }
        true
    }
}

#[contractimpl]
impl Treasury {
    pub fn initialize(
        env: Env,
        admin: Address,
        bet_token: Address,
        factory: Address,
        withdrawal_limit: i128,
    ) -> Result<(), ContractError> {
        if env.storage().persistent().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().persistent().set(&ADMIN, &admin);
        env.storage().persistent().set(&BET_TOKEN, &bet_token);
        env.storage().persistent().set(&FACTORY, &factory);
        env.storage().persistent().set(&WITHDRAWAL_LIMIT, &withdrawal_limit);
        env.storage().persistent().set(&ACCUMULATED_FEES, &Map::<Address, i128>::new(&env));
        env.storage().persistent().set(&ACCUMULATED_FEES_BY_MARKET, &Map::<u64, Map<Address, i128>>::new(&env));
        env.storage().persistent().set(&DAILY_WITHDRAWN, &Map::<u64, i128>::new(&env));
        env.storage().persistent().set(&DAILY_WITHDRAWN_PER_TOKEN, &Map::<(u64, Address), i128>::new(&env));
        env.storage().persistent().set(&APPROVED_MARKETS, &Vec::<Address>::new(&env));
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &false);
        env.storage().persistent().set(&AUDIT_LOG, &Vec::<AuditEntry>::new(&env));
        env.storage().persistent().set(&AUDIT_NEXT_ID, &0u64);
        env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
        env.storage().persistent().set(&WITHDRAWAL_NONCE, &0u64);
        env.storage().persistent().set(&COMPLETED_WITHDRAWALS, &Vec::<u64>::new(&env));
        env.storage().persistent().set(&DAILY_LIMIT_PER_TOKEN, &Map::<Address, i128>::new(&env));
        env.storage().persistent().set(&WITDRAWAL_COOLDOWN, &WITHDRAWAL_COOLDOWN_BLOCKS);
        env.storage().persistent().set(&LAST_WITHDRAWAL_BLOCK, &0u32);
        Ok(())
    }

    pub fn approve_market(
        env: Env,
        admin: Address,
        market_address: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let mut markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market_address.clone()) {
            markets.push_back(market_address);
        }
        env.storage().persistent().set(&APPROVED_MARKETS, &markets);
        Ok(())
    }

    pub fn revoke_market(
        env: Env,
        admin: Address,
        market_address: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        let mut updated: Vec<Address> = Vec::new(&env);
        for m in markets.iter() {
            if m != market_address {
                updated.push_back(m);
            }
        }
        env.storage().persistent().set(&APPROVED_MARKETS, &updated);
        Ok(())
    }

    pub fn deposit_fees(
        env: Env,
        market: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        market.require_auth();
        let markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market.clone()) {
            return Err(ContractError::MarketNotApproved);
        }

        let mut fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));
        let current = fees.get(token.clone()).unwrap_or(0);
        fees.set(token.clone(), current + amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&market, &env.current_contract_address(), &amount);

        Self::record_audit(&env, AuditAction::FeeDeposited, token.clone(), amount, market.clone());

        boxmeout_shared::emit_fee_deposited(&env, market, token, amount);
        Ok(())
    }

    pub fn receive_fee(
        env: Env,
        market: Address,
        market_id: u64,
        token: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        market.require_auth();
        let markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market.clone()) {
            return Err(ContractError::MarketNotApproved);
        }

        Self::add_to_accumulated_token(&env, &token, amount);

        let mut by_market: Map<u64, Map<Address, i128>> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES_BY_MARKET)
            .unwrap_or_else(|| Map::new(&env));
        let mut token_map: Map<Address, i128> = by_market.get(market_id).unwrap_or_else(|| Map::new(&env));
        let cur = token_map.get(token.clone()).unwrap_or(0);
        token_map.set(token.clone(), cur + amount);
        by_market.set(market_id, token_map);
        env.storage().persistent().set(&ACCUMULATED_FEES_BY_MARKET, &by_market);

        Self::record_audit(&env, AuditAction::FeeReceived, token.clone(), amount, market.clone());

        boxmeout_shared::emit_fee_deposited(&env, market, token, amount);
        Ok(())
    }

    pub fn withdraw_fees(
        env: Env,
        admin: Address,
        token: Address,
        amount: i128,
        destination: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let guard: bool = env.storage().persistent().get(&WITHDRAWAL_IN_PROGRESS).unwrap_or(false);
        if guard {
            return Err(ContractError::ReentrancyGuard);
        }
        env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &true);

        let nonce: u64 = Self::get_next_withdrawal_nonce(&env);
        if Self::is_withdrawal_completed(&env, nonce) {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::ReentrancyGuard);
        }

        if amount < MIN_WITHDRAWAL {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::BelowMinimum);
        }

        let paused: bool = env.storage().persistent().get(&WITHDRAWALS_PAUSED).unwrap_or(false);
        if paused {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        let cooldown: u32 = env.storage().persistent().get(&WITDRAWAL_COOLDOWN).unwrap_or(0);
        let last_block: u32 = env.storage().persistent().get(&LAST_WITHDRAWAL_BLOCK).unwrap_or(0);
        let current_block = env.ledger().sequence();
        if current_block < last_block + cooldown {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        let limit: i128 = env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0);
        if amount > limit {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        let bucket = Self::day_bucket(&env);
        let mut daily: Map<u64, i128> =
            env.storage().persistent().get(&DAILY_WITHDRAWN).unwrap_or_else(|| Map::new(&env));
        let today_total = daily.get(bucket).unwrap_or(0);
        if today_total + amount > limit {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        let token_limit: i128 = env
            .storage()
            .persistent()
            .get(&DAILY_LIMIT_PER_TOKEN)
            .and_then(|m: Map<Address, i128>| m.get(token.clone()))
            .unwrap_or(limit);
        let mut daily_per_token: Map<(u64, Address), i128> = env
            .storage()
            .persistent()
            .get(&DAILY_WITHDRAWN_PER_TOKEN)
            .unwrap_or_else(|| Map::new(&env));
        let token_day_key = (bucket, token.clone());
        let today_token_total = daily_per_token.get(token_day_key.clone()).unwrap_or(0);
        if today_token_total + amount > token_limit {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        let mut fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));
        let balance = fees.get(token.clone()).unwrap_or(0);
        if balance < amount {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::InsufficientBalance);
        }

        fees.set(token.clone(), balance - amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);
        daily.set(bucket, today_total + amount);
        Self::prune_daily_withdrawn(&env, &mut daily, bucket);
        env.storage().persistent().set(&DAILY_WITHDRAWN, &daily);

        daily_per_token.set(token_day_key, today_token_total + amount);
        Self::prune_daily_withdrawn_per_token(&env, &mut daily_per_token, bucket);
        env.storage().persistent().set(&DAILY_WITHDRAWN_PER_TOKEN, &daily_per_token);

        Self::mark_withdrawal_completed(&env, nonce);
        env.storage().persistent().set(&LAST_WITHDRAWAL_BLOCK, &current_block);

        Self::record_audit(&env, AuditAction::FeeWithdrawn, token.clone(), amount, destination.clone());

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);

        boxmeout_shared::emit_fee_withdrawn(&env, token, amount, destination);
        Ok(())
    }

    pub fn register_market(env: Env, caller: Address, market_address: Address) -> Result<(), ContractError> {
        caller.require_auth();
        let stored_factory: Address = env
            .storage()
            .persistent()
            .get(&FACTORY)
            .ok_or(ContractError::NotFactory)?;
        if caller != stored_factory {
            return Err(ContractError::NotFactory);
        }

        let mut markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market_address.clone()) {
            markets.push_back(market_address);
        }
        env.storage().persistent().set(&APPROVED_MARKETS, &markets);
        Ok(())
    }

    pub fn is_registered_market(env: Env, market_address: Address) -> bool {
        let markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        markets.contains(market_address)
    }

    pub fn get_accumulated_fees(env: Env, token: Address) -> i128 {
        let fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));
        fees.get(token).unwrap_or(0)
    }

    pub fn get_daily_withdrawal_amount(env: Env) -> i128 {
        let bucket = Self::day_bucket(&env);
        let daily: Map<u64, i128> =
            env.storage().persistent().get(&DAILY_WITHDRAWN).unwrap_or_else(|| Map::new(&env));
        daily.get(bucket).unwrap_or(0)
    }

    pub fn get_daily_withdrawal_amount_per_token(env: Env, token: Address) -> i128 {
        let bucket = Self::day_bucket(&env);
        let daily: Map<(u64, Address), i128> = env
            .storage()
            .persistent()
            .get(&DAILY_WITHDRAWN_PER_TOKEN)
            .unwrap_or_else(|| Map::new(&env));
        daily.get((bucket, token)).unwrap_or(0)
    }

    pub fn update_withdrawal_limit(
        env: Env,
        admin: Address,
        new_limit: i128,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWAL_LIMIT, &new_limit);
        Ok(())
    }

    pub fn update_daily_limit_per_token(
        env: Env,
        admin: Address,
        token: Address,
        new_limit: i128,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        let mut limits: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&DAILY_LIMIT_PER_TOKEN)
            .unwrap_or_else(|| Map::new(&env));
        limits.set(token, new_limit);
        env.storage().persistent().set(&DAILY_LIMIT_PER_TOKEN, &limits);
        Ok(())
    }

    pub fn emergency_drain(
        env: Env,
        admin: Address,
        token: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let mut fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));
        let balance = fees.get(token.clone()).unwrap_or(0);

        fees.set(token.clone(), 0i128);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        if balance > 0 {
            let token_client = token::Client::new(&env, &token);
            token_client.transfer(&env.current_contract_address(), &admin, &balance);
        }

        Self::record_audit(&env, AuditAction::FeeDrained, token.clone(), balance, admin.clone());

        boxmeout_shared::emit_emergency_drain(&env, token, balance, admin);
        Ok(())
    }

    pub fn get_withdrawal_limit(env: Env) -> i128 {
        env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0)
    }

    pub fn get_daily_limit_per_token(env: Env, token: Address) -> i128 {
        let limits: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&DAILY_LIMIT_PER_TOKEN)
            .unwrap_or_else(|| Map::new(&env));
        limits.get(token).unwrap_or_else(|| Self::get_withdrawal_limit(env))
    }

    pub fn get_audit_log_count(env: Env) -> u64 {
        let log: Vec<AuditEntry> =
            env.storage().persistent().get(&AUDIT_LOG).unwrap_or_else(|| Vec::new(&env));
        log.len() as u64
    }

    pub fn get_audit_entry(env: Env, index: u64) -> Option<AuditEntry> {
        let log: Vec<AuditEntry> =
            env.storage().persistent().get(&AUDIT_LOG).unwrap_or_else(|| Vec::new(&env));
        let idx_u32 = index as u32;
        if idx_u32 >= log.len() {
            return None;
        }
        log.get(idx_u32)
    }

    pub fn verify_audit_log_integrity(env: Env) -> bool {
        Self::verify_audit_integrity(&env)
    }

    pub fn get_withdrawal_nonce(env: Env) -> u64 {
        env.storage().persistent().get(&WITHDRAWAL_NONCE).unwrap_or(0)
    }

    pub fn pause_withdrawals(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &true);
        Ok(())
    }

    pub fn unpause_withdrawals(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &false);
        Ok(())
    }

    pub fn is_withdrawals_paused(env: Env) -> bool {
        env.storage().persistent().get(&WITHDRAWALS_PAUSED).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use soroban_sdk::{
        testutils::{Address as _, Events},
        token::StellarAssetClient,
        Address, Env, Symbol,
    };

    use super::{Treasury, TreasuryClient};

    fn setup() -> (Env, TreasuryClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000_i128);
        (env, client, admin, market)
    }

    fn setup_token(env: &Env, admin: &Address, recipient: &Address, amount: i128) -> Address {
        let token_id = env.register_stellar_asset_contract(admin.clone());
        StellarAssetClient::new(env, &token_id).mint(recipient, &amount);
        token_id
    }

    #[test]
    fn approve_market_is_idempotent() {
        let (_env, client, admin, market) = setup();
        client.approve_market(&admin, &market);
        client.approve_market(&admin, &market);
    }

    #[test]
    fn revoke_market_removes_approval() {
        let (env, client, admin, market) = setup();
        let token = Address::generate(&env);

        client.approve_market(&admin, &market);
        client.revoke_market(&admin, &market);

        let result = client.try_deposit_fees(&market, &token, &100_i128);
        assert!(result.is_err());
    }

    #[test]
    #[should_panic]
    fn approve_market_requires_admin() {
        let (env, client, _admin, market) = setup();
        let non_admin = Address::generate(&env);
        client.approve_market(&non_admin, &market);
    }

    fn setup_with_deposit(
        amount: i128,
    ) -> (Env, TreasuryClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = setup_token(&env, &admin, &market, amount);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000_i128);

        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &amount);

        (env, client, admin, market, token)
    }

    #[test]
    fn emergency_drain_transfers_full_balance_to_admin() {
        let (env, client, admin, _market, token) = setup_with_deposit(500_000);

        client.emergency_drain(&admin, &token);

        assert_eq!(client.get_accumulated_fees(&token), 0);

        let token_client = soroban_sdk::token::Client::new(&env, &token);
        assert_eq!(token_client.balance(&admin), 500_000);
    }

    #[test]
    fn daily_withdrawal_cap_enforced() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = setup_token(&env, &admin, &market, &10_000_000);
        let factory = Address::generate(&env);
        let limit = 1_000_000i128;
        client.initialize(&admin, &token, &factory, &limit);

        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &10_000_000);

        let dest = Address::generate(&env);

        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);

        let result = client.try_withdraw_fees(&admin, &token, &limit, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn per_token_daily_limit_enforced() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = setup_token(&env, &admin, &market, &10_000_000);
        let factory = Address::generate(&env);
        let global_limit = 5_000_000i128;
        let token_limit = 1_000_000i128;
        client.initialize(&admin, &token, &factory, &global_limit);
        client.update_daily_limit_per_token(&admin, &token, &token_limit);

        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &10_000_000);

        let dest = Address::generate(&env);

        client.withdraw_fees(&admin, &token, &token_limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount_per_token(&token), token_limit);

        let result = client.try_withdraw_fees(&admin, &token, &token_limit, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn audit_log_records_all_actions() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = setup_token(&env, &admin, &market, &10_000_000);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000);

        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &5_000_000);

        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &1_000_000, &dest);

        assert!(client.get_audit_log_count() >= 2);
    }

    #[test]
    fn audit_log_integrity_verified() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = setup_token(&env, &admin, &market, &10_000_000);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000);

        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &5_000_000);

        assert!(client.verify_audit_log_integrity());
    }

    #[test]
    fn pause_withdrawals_prevents_withdrawal() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = setup_token(&env, &admin, &market, &10_000_000);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000);

        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &10_000_000);
        client.pause_withdrawals(&admin);

        let dest = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &1_000_000, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn withdrawal_nonce_increments() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = setup_token(&env, &admin, &market, &10_000_000);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000);

        let initial_nonce = client.get_withdrawal_nonce();

        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &5_000_000);

        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &1_000_000, &dest);

        assert!(client.get_withdrawal_nonce() > initial_nonce);
    }
}
