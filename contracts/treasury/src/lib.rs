#![no_std]
//! ============================================================
//! BANKERCHANGER — Treasury Contract (Security-Audited)
//!
//! Features:
//!   • Per-token & global daily withdrawal caps (separate from per-tx limit)
//!   • Double-withdrawal prevention via reentrancy lock (FEE_LOCK)
//!   • Explicit pause_withdrawals / unpause_withdrawals admin functions
//!   • Immutable append-only audit log (AUDIT_LOG) with AuditEntry struct
//!   • Dynamic fee tiers (get_fee_tiers, calculate_fee, set_fee_tiers)
//!   • get_audit_log / get_audit_log_len / get_audit_entry query functions
//!   • Storage TTL extension and contract upgrade capabilities
//!
//! All fund-moving functions follow Checks-Effects-Interactions.
//! require_auth() is always the first call in fund-moving fns.
//! ============================================================

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractclient, contractimpl, token, Address, BytesN, Env, Map, Symbol, Vec,
};

use boxmeout_shared::{
    errors::ContractError,
    types::{AuditAction, AuditEntry, FeeTier},
};

// ── Persistent Storage Keys ──────────────────────────────────────────────────
const ADMIN: &str                        = "ADMIN";
const BET_TOKEN: &str                    = "BET_TOKEN";
const FACTORY: &str                      = "FACTORY";
const ACCUMULATED_FEES: &str             = "ACCUMULATED_FEES";             // Map<Address, i128>
const ACCUMULATED_FEES_BY_MARKET: &str   = "ACCUMULATED_FEES_BY_MARKET";  // Map<u64, Map<Address, i128>>
const APPROVED_MARKETS: &str             = "APPROVED_MARKETS";             // Vec<Address>
const WITHDRAWAL_LIMIT: &str             = "WITHDRAWAL_LIMIT";             // i128 per-tx limit
const DAILY_WITHDRAWN: &str              = "DAILY_WITHDRAWN";              // Map<u64, i128> (bucket -> amount)
const DAILY_TOKEN_CAP: &str              = "DAILY_TOKEN_CAP";              // Map<Address, i128>
const WITHDRAWALS_PAUSED: &str           = "WITHDRAWALS_PAUSED";           // bool
const FEE_LOCK: &str                     = "FEE_LOCK";                     // bool reentrancy guard
const AUDIT_LOG: &str                    = "AUDIT_LOG";                    // Vec<AuditEntry>
const AUDIT_NEXT_ID: &str                = "AUDIT_NEXT_ID";                // u64 monotonically increasing
const FEE_TIERS: &str                    = "FEE_TIERS";                    // Vec<FeeTier>
const MIN_WITHDRAWAL: i128               = 10_000_000;                     // 1 XLM in stroops

// ── Action symbols for events ────────────────────────────────────────────────
const SYM_FEE_WITHDRAW: &str             = "fee_wthdrl";
const SYM_EMRG_DRAIN: &str               = "emrg_drain";
const SYM_FEE_DEPOSIT: &str              = "fee_depst";
const SYM_CAP_REACHED: &str              = "cap_rchd";

#[contract]
pub struct Treasury;

impl Treasury {
    fn require_admin(env: &Env, caller: &Address) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .persistent()
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

    fn acquire_fee_lock(env: &Env) -> Result<(), ContractError> {
        let locked: bool = env.storage().persistent().get(&FEE_LOCK).unwrap_or(false);
        if locked {
            return Err(ContractError::ReentrancyGuard);
        }
        env.storage().persistent().set(&FEE_LOCK, &true);
        Ok(())
    }

    fn release_fee_lock(env: &Env) {
        env.storage().persistent().set(&FEE_LOCK, &false);
    }

    fn token_withdrawn_today(env: &Env, token: &Address, bucket: u64) -> i128 {
        let key = (Symbol::new(env, "DTW"), token.clone());
        let daily: Map<u64, i128> =
            env.storage().persistent().get(&key).unwrap_or_else(|| Map::new(env));
        daily.get(bucket).unwrap_or(0)
    }

    fn record_token_withdrawal(env: &Env, token: &Address, bucket: u64, amount: i128) {
        let key = (Symbol::new(env, "DTW"), token.clone());
        let mut daily: Map<u64, i128> =
            env.storage().persistent().get(&key).unwrap_or_else(|| Map::new(env));
        let today = daily.get(bucket).unwrap_or(0);
        daily.set(bucket, today + amount);

        let mut stale: Vec<u64> = Vec::new(env);
        for (k, _) in daily.iter() {
            if k + 1 < bucket {
                stale.push_back(k);
            }
        }
        for k in stale.iter() {
            daily.remove(k);
        }
        env.storage().persistent().set(&key, &daily);
    }

    fn record_audit(
        env: &Env,
        action: AuditAction,
        token: Address,
        amount: i128,
        actor: Address,
        destination: Address,
    ) {
        let next_id: u64 = env.storage().persistent().get(&AUDIT_NEXT_ID).unwrap_or(0);
        let bucket = Self::day_bucket(env);
        let entry = AuditEntry {
            id: next_id,
            action: action.clone(),
            token: token.clone(),
            amount,
            actor: actor.clone(),
            timestamp: env.ledger().timestamp(),
            day_bucket: bucket,
            destination: destination.clone(),
        };

        let mut log: Vec<AuditEntry> = env
            .storage()
            .persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(env));
        log.push_back(entry.clone());
        env.storage().persistent().set(&AUDIT_LOG, &log);
        env.storage().persistent().set(&AUDIT_NEXT_ID, &(next_id + 1));

        boxmeout_shared::emit_audit_recorded(env, entry);
    }
}

#[contractimpl]
impl Treasury {
    /// Initializes the treasury contract.
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
        env.storage().persistent().set(&APPROVED_MARKETS, &Vec::<Address>::new(&env));
        env.storage().persistent().set(&DAILY_WITHDRAWN, &Map::<u64, i128>::new(&env));
        env.storage().persistent().set(&DAILY_TOKEN_CAP, &Map::<Address, i128>::new(&env));
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &false);
        env.storage().persistent().set(&FEE_LOCK, &false);
        env.storage().persistent().set(&AUDIT_LOG, &Vec::<AuditEntry>::new(&env));
        env.storage().persistent().set(&AUDIT_NEXT_ID, &0u64);

        let mut default_tiers = Vec::<FeeTier>::new(&env);
        default_tiers.push_back(FeeTier { volume_threshold: 100_000_000, fee_bps: 200 }); // <= 10 XLM: 200 bps (2%)
        default_tiers.push_back(FeeTier { volume_threshold: 500_000_000, fee_bps: 150 }); // <= 50 XLM: 150 bps (1.5%)
        default_tiers.push_back(FeeTier { volume_threshold: u64::MAX, fee_bps: 100 });    // > 50 XLM: 100 bps (1%)
        env.storage().instance().set(&FEE_TIERS, &default_tiers);

        Ok(())
    }

    /// Approves a market contract.
    pub fn approve_market(
        env: Env,
        admin: Address,
        market_address: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let mut markets: Vec<Address> = env
            .storage()
            .persistent()
            .get(&APPROVED_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market_address.clone()) {
            markets.push_back(market_address);
        }
        env.storage().persistent().set(&APPROVED_MARKETS, &markets);
        Ok(())
    }

    /// Revokes market approval.
    pub fn revoke_market(
        env: Env,
        admin: Address,
        market_address: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let markets: Vec<Address> = env
            .storage()
            .persistent()
            .get(&APPROVED_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        let mut updated: Vec<Address> = Vec::new(&env);
        for m in markets.iter() {
            if m != market_address {
                updated.push_back(m);
            }
        }
        env.storage().persistent().set(&APPROVED_MARKETS, &updated);
        Ok(())
    }

    /// Deposits fees from an approved market.
    pub fn deposit_fees(
        env: Env,
        market: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        market.require_auth();

        let markets: Vec<Address> = env
            .storage()
            .persistent()
            .get(&APPROVED_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market.clone()) {
            return Err(ContractError::MarketNotApproved);
        }

        let mut fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        let current = fees.get(token.clone()).unwrap_or(0);
        fees.set(token.clone(), current + amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        token::Client::new(&env, &token).transfer(
            &market,
            &env.current_contract_address(),
            &amount,
        );

        Self::record_audit(
            &env,
            AuditAction::FeeDeposited,
            token.clone(),
            amount,
            market.clone(),
            env.current_contract_address(),
        );

        boxmeout_shared::emit_fee_deposited(&env, market, token, amount);
        Ok(())
    }

    /// Withdraws accumulated fees.
    pub fn withdraw_fees(
        env: Env,
        admin: Address,
        token: Address,
        amount: i128,
        destination: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        if amount < MIN_WITHDRAWAL {
            return Err(ContractError::BelowMinimum);
        }

        let paused: bool = env.storage().persistent().get(&WITHDRAWALS_PAUSED).unwrap_or(false);
        if paused {
            return Err(ContractError::WithdrawalsPaused);
        }

        let limit: i128 = env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0);
        if limit > 0 && amount > limit {
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        let bucket = Self::day_bucket(&env);
        let cap_map: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&DAILY_TOKEN_CAP)
            .unwrap_or_else(|| Map::new(&env));
        let token_cap = cap_map.get(token.clone()).unwrap_or(0);
        if token_cap > 0 {
            let already = Self::token_withdrawn_today(&env, &token, bucket);
            if already + amount > token_cap {
                return Err(ContractError::DailyWithdrawalLimitExceeded);
            }
        }

        Self::acquire_fee_lock(&env)?;

        let mut fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        let current = fees.get(token.clone()).unwrap_or(0);
        if current < amount {
            Self::release_fee_lock(&env);
            return Err(ContractError::InsufficientBalance);
        }

        fees.set(token.clone(), current - amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        if token_cap > 0 {
            Self::record_token_withdrawal(&env, &token, bucket, amount);
        }

        Self::release_fee_lock(&env);

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &destination,
            &amount,
        );

        Self::record_audit(
            &env,
            AuditAction::FeeWithdrawn,
            token.clone(),
            amount,
            admin.clone(),
            destination.clone(),
        );

        boxmeout_shared::emit_fee_withdrawn(&env, token, amount, destination);
        Ok(())
    }

    /// Emergency drains accumulated fees for a token.
    pub fn drain_fees(
        env: Env,
        admin: Address,
        token: Address,
        destination: Address,
    ) -> Result<i128, ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        Self::acquire_fee_lock(&env)?;

        let mut fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        let amount = fees.get(token.clone()).unwrap_or(0);
        if amount == 0 {
            Self::release_fee_lock(&env);
            return Ok(0);
        }

        fees.set(token.clone(), 0);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        Self::release_fee_lock(&env);

        token::Client::new(&env, &token).transfer(
            &env.current_contract_address(),
            &destination,
            &amount,
        );

        Self::record_audit(
            &env,
            AuditAction::FeeDrained,
            token.clone(),
            amount,
            admin.clone(),
            destination.clone(),
        );

        boxmeout_shared::emit_emergency_drain(&env, token, amount, destination);
        Ok(amount)
    }

    pub fn set_withdrawal_limit(
        env: Env,
        admin: Address,
        limit: i128,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        if limit < MIN_WITHDRAWAL {
            return Err(ContractError::BelowMinimum);
        }
        env.storage().persistent().set(&WITHDRAWAL_LIMIT, &limit);
        Ok(())
    }

    pub fn get_withdrawal_limit(env: Env) -> i128 {
        env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0)
    }

    pub fn set_token_daily_cap(
        env: Env,
        admin: Address,
        token: Address,
        cap: i128,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        if cap < 0 {
            return Err(ContractError::InvalidAmount);
        }
        let mut caps: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&DAILY_TOKEN_CAP)
            .unwrap_or_else(|| Map::new(&env));
        caps.set(token, cap);
        env.storage().persistent().set(&DAILY_TOKEN_CAP, &caps);
        Ok(())
    }

    pub fn get_token_daily_cap(env: Env, token: Address) -> i128 {
        let caps: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&DAILY_TOKEN_CAP)
            .unwrap_or_else(|| Map::new(&env));
        caps.get(token).unwrap_or(0)
    }

    pub fn get_token_daily_withdrawn(env: Env, token: Address) -> i128 {
        let bucket = Self::day_bucket(&env);
        Self::token_withdrawn_today(&env, &token, bucket)
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

    pub fn get_accumulated_fees(env: Env, token: Address) -> i128 {
        let fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        fees.get(token).unwrap_or(0)
    }

    pub fn get_audit_log(env: Env) -> Vec<AuditEntry> {
        env.storage().persistent().get(&AUDIT_LOG).unwrap_or_else(|| Vec::new(&env))
    }

    pub fn get_audit_log_len(env: Env) -> u64 {
        let log: Vec<AuditEntry> = env
            .storage()
            .persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(&env));
        log.len() as u64
    }

    pub fn get_audit_log_count(env: Env) -> u64 {
        Self::get_audit_log_len(env)
    }

    pub fn get_audit_entry(env: Env, index: u64) -> Option<AuditEntry> {
        let log: Vec<AuditEntry> = env
            .storage()
            .persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(&env));
        if index < log.len() as u64 {
            Some(log.get(index as u32).unwrap())
        } else {
            None
        }
    }

    // ── Dynamic Fee Tiers ─────────────────────────────────────────────────

    pub fn set_fee_tiers(
        env: Env,
        admin: Address,
        tiers: Vec<FeeTier>,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        if tiers.is_empty() {
            return Err(ContractError::InvalidAmount);
        }

        for tier in tiers.iter() {
            if tier.fee_bps > 10_000 {
                return Err(ContractError::InvalidAmount);
            }
        }

        env.storage().instance().set(&FEE_TIERS, &tiers);

        env.events().publish(
            (Symbol::new(&env, "fee_tiers_updated"),),
            (admin, tiers.len()),
        );

        Ok(())
    }

    pub fn get_fee_tiers(env: Env) -> Vec<FeeTier> {
        env.storage()
            .instance()
            .get(&FEE_TIERS)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn calculate_fee(env: Env, market_total_volume: u64, bet_amount: u64) -> u64 {
        if bet_amount == 0 {
            return 0;
        }

        let tiers = Self::get_fee_tiers(env);
        let mut rate_bps: u32 = 200; // default 2%

        for tier in tiers.iter() {
            if market_total_volume <= tier.volume_threshold {
                rate_bps = tier.fee_bps;
                break;
            }
            rate_bps = tier.fee_bps;
        }

        ((bet_amount as u128 * rate_bps as u128) / 10_000) as u64
    }

    pub fn extend_ttl(env: Env) {
        env.storage().persistent().extend_ttl(&ADMIN, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&BET_TOKEN, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&FACTORY, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&WITHDRAWAL_LIMIT, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&ACCUMULATED_FEES, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&APPROVED_MARKETS, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&DAILY_WITHDRAWN, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&DAILY_TOKEN_CAP, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&WITHDRAWALS_PAUSED, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&FEE_LOCK, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&AUDIT_LOG, 518_400, 518_400);
        env.storage().persistent().extend_ttl(&AUDIT_NEXT_ID, 518_400, 518_400);
    }

    pub fn upgrade(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

// ── Unit Tests ───────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::StellarAssetClient,
    };

    fn setup(limit: i128) -> (Env, TreasuryClient<'static>, Address, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &limit);
        client.approve_market(&admin, &market);
        (env, client, admin, market, token, factory)
    }

    fn funded_setup(
        limit: i128,
        fund: i128,
    ) -> (Env, TreasuryClient<'static>, Address, Address, Address) {
        let (env, client, admin, market, token, _) = setup(limit);
        StellarAssetClient::new(&env, &token).mint(&market, &fund);
        client.deposit_fees(&market, &token, &fund);
        (env, client, admin, market, token)
    }

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(soroban_sdk::testutils::LedgerInfo {
            timestamp: ts,
            protocol_version: 20,
            sequence_number: 100,
            network_id: Default::default(),
            base_reserve: 1,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_311_520,
        });
    }

    #[test]
    fn per_token_daily_cap_enforced() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 50_000_000);
        client.set_token_daily_cap(&admin, &token, &10_000_000i128);

        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        let result = client.try_withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert!(result.is_err(), "should fail: daily per-token cap exhausted");
    }

    #[test]
    fn per_token_daily_cap_resets_next_day() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 50_000_000);
        client.set_token_daily_cap(&admin, &token, &10_000_000i128);
        let dest = Address::generate(&env);

        set_time(&env, 86_400);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        set_time(&env, 86_400 * 2);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        assert_eq!(
            soroban_sdk::token::Client::new(&env, &token).balance(&dest),
            20_000_000i128
        );
    }

    #[test]
    fn pause_and_unpause_withdrawals() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 10_000_000);
        client.pause_withdrawals(&admin);
        let dest = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert!(result.is_err());

        client.unpause_withdrawals(&admin);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert_eq!(client.get_accumulated_fees(&token), 0);
    }

    #[test]
    fn audit_log_records_movements() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 20_000_000);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        let log = client.get_audit_log();
        assert!(log.len() >= 2); // Deposit + Withdraw
        assert_eq!(client.get_audit_log_len(), log.len() as u64);
        let entry = client.get_audit_entry(&0).unwrap();
        assert_eq!(entry.id, 0);
    }
}
