#![no_std]
//! ============================================================
//! BOXMEOUT — Treasury Contract (Security-Audited)
//! All fund-moving functions follow Checks-Effects-Interactions.
//! require_auth() is always the first call.
//!
//! Task 11 additions:
//!   • Daily withdrawal cap enforcement (DAILY_WITHDRAWN tracked per bucket)
//!   • Concurrency-safe fee extraction via FEE_EXTRACTION_LOCK flag
//!   • Immutable on-chain audit trail (AUDIT_LOG Vec<AuditEntry>)
//! ============================================================

use soroban_sdk::{contract, contractimpl, token, Address, Env, Map, Symbol, Vec};

use boxmeout_shared::{
    errors::ContractError,
    types::{AuditAction, AuditEntry},
};

// ── Storage keys ──────────────────────────────────────────────────────────────
const ADMIN: &str                        = "ADMIN";
const BET_TOKEN: &str                    = "BET_TOKEN";
const FACTORY: &str                      = "FACTORY";
const ACCUMULATED_FEES: &str             = "ACCUMULATED_FEES";        // Map<Address, i128>
const ACCUMULATED_FEES_BY_MARKET: &str   = "ACCUMULATED_FEES_BY_MARKET"; // Map<u64, Map<Address, i128>>
const APPROVED_MARKETS: &str             = "APPROVED_MARKETS";        // Vec<Address>
const WITHDRAWAL_LIMIT: &str             = "WITHDRAWAL_LIMIT";        // i128 per-tx cap
const DAILY_WITHDRAWN: &str              = "DAILY_WITHDRAWN";         // Map<u64, i128>
const WITHDRAWALS_PAUSED: &str           = "WITHDRAWALS_PAUSED";      // bool
const FEE_EXTRACTION_LOCK: &str          = "FEE_EXTRACTION_LOCK";     // bool — concurrency guard
const AUDIT_LOG: &str                    = "AUDIT_LOG";               // Vec<AuditEntry>

const MIN_WITHDRAWAL: i128               = 10_000_000; // 1 XLM in stroops

// ── Action symbols (short — ≤ 9 chars) ───────────────────────────────────────
// Used as the `action` topic in emit_audit_log.
const SYM_FEE_WITHDRAW:   &str = "fee_wthdrl";
const SYM_EMRG_DRAIN:     &str = "emrg_drain";
const SYM_FEE_DEPOSIT:    &str = "fee_depst";
const SYM_CAP_REACHED:    &str = "cap_rchd";

#[contract]
pub struct Treasury;

// ── Internal helpers ──────────────────────────────────────────────────────────
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

    fn add_to_accumulated_token(env: &Env, token: &Address, amount: i128) {
        let mut fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(env));
        let current = fees.get(token.clone()).unwrap_or(0);
        fees.set(token.clone(), current + amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);
    }

    // ── Concurrency guard helpers ─────────────────────────────────────────────

    /// Acquires the fee-extraction lock.  Returns `FeeExtractionInProgress` if
    /// another invocation already holds it (should not happen on Soroban, but
    /// serves as an explicit single-writer guard for fee flows).
    fn acquire_extraction_lock(env: &Env) -> Result<(), ContractError> {
        let locked: bool = env
            .storage().temporary()
            .get(&FEE_EXTRACTION_LOCK)
            .unwrap_or(false);
        if locked {
            return Err(ContractError::FeeExtractionInProgress);
        }
        // TTL of 1 ledger — the lock is released when the invocation ends or
        // when release_extraction_lock() is called, whichever comes first.
        env.storage().temporary().set(&FEE_EXTRACTION_LOCK, &true);
        env.storage().temporary().extend_ttl(&FEE_EXTRACTION_LOCK, 1, 1);
        Ok(())
    }

    /// Releases the fee-extraction lock.
    fn release_extraction_lock(env: &Env) {
        env.storage().temporary().set(&FEE_EXTRACTION_LOCK, &false);
    }

    // ── Audit trail helpers ───────────────────────────────────────────────────

    /// Appends an immutable entry to the persistent AUDIT_LOG.
    fn append_audit_log(
        env: &Env,
        action: AuditAction,
        token: &Address,
        amount: i128,
        actor: &Address,
    ) {
        let mut log: Vec<AuditEntry> = env
            .storage().persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(env));

        let entry = AuditEntry {
            timestamp:  env.ledger().timestamp(),
            action:     action.clone(),
            token:      token.clone(),
            amount,
            actor:      actor.clone(),
            day_bucket: Self::day_bucket(env),
        };
        log.push_back(entry);
        env.storage().persistent().set(&AUDIT_LOG, &log);

        // Also emit a lightweight event so off-chain indexers can track without
        // re-reading the full vector from storage.
        let action_sym: Symbol = match action {
            AuditAction::FeeWithdrawal  => Symbol::new(env, SYM_FEE_WITHDRAW),
            AuditAction::EmergencyDrain => Symbol::new(env, SYM_EMRG_DRAIN),
            AuditAction::FeeDeposit     => Symbol::new(env, SYM_FEE_DEPOSIT),
            AuditAction::DailyCapReached => Symbol::new(env, SYM_CAP_REACHED),
        };
        boxmeout_shared::emit_audit_log(
            env,
            action_sym,
            token.clone(),
            amount,
            actor.clone(),
            env.ledger().timestamp(),
            Self::day_bucket(env),
        );
    }

    // ── Daily cap helpers ─────────────────────────────────────────────────────

    /// Checks and updates the daily withdrawal cumulative cap.
    ///
    /// The daily cap is `withdrawal_limit * 5`.  If the requested `amount` would
    /// push today's total over the cap, `DailyCapReached` is returned and no
    /// storage is mutated.  On success the updated daily total is written.
    ///
    /// Note: Soroban reverts all state changes on a failed invocation, so there
    /// is no point writing audit entries here on the error path — they would be
    /// rolled back anyway.  Cap-exceeded events are surfaced to callers via the
    /// `DailyCapReached` error code.
    fn check_and_update_daily_cap(
        env: &Env,
        amount: i128,
        limit: i128,
    ) -> Result<(), ContractError> {
        let bucket    = Self::day_bucket(env);
        let daily_cap = limit.saturating_mul(5);

        let mut daily: Map<u64, i128> = env
            .storage().persistent()
            .get(&DAILY_WITHDRAWN)
            .unwrap_or_else(|| Map::new(env));
        let today_total = daily.get(bucket).unwrap_or(0);

        if today_total + amount > daily_cap {
            return Err(ContractError::DailyCapReached);
        }

        daily.set(bucket, today_total + amount);
        env.storage().persistent().set(&DAILY_WITHDRAWN, &daily);
        Ok(())
    }
}

// ── Public contract interface ─────────────────────────────────────────────────
#[contractimpl]
impl Treasury {
    /// Initializes the treasury with admin and withdrawal limit.
    ///
    /// # Errors
    /// - `AlreadyInitialized`: Treasury has already been initialized
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
        env.storage().persistent().set(&APPROVED_MARKETS, &Vec::<Address>::new(&env));
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &false);
        env.storage().persistent().set(&AUDIT_LOG, &Vec::<AuditEntry>::new(&env));
        Ok(())
    }

    /// Approves a market contract to deposit fees.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
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

    /// Revokes a market contract's permission to deposit fees.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
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

    /// Deposits fees from an approved market contract.
    ///
    /// # Errors
    /// - `MarketNotApproved`: Market is not in the approved list
    ///
    /// # Security (CEI)
    /// 1. CHECKS: caller in APPROVED_MARKETS, market.require_auth()
    /// 2. EFFECTS: increment ACCUMULATED_FEES + append audit entry
    /// 3. INTERACTIONS: token transfer last
    pub fn deposit_fees(
        env: Env,
        market: Address,
        token: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        // CHECKS
        market.require_auth();
        let markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market.clone()) {
            return Err(ContractError::MarketNotApproved);
        }

        // EFFECTS
        let mut fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));
        let current = fees.get(token.clone()).unwrap_or(0);
        fees.set(token.clone(), current + amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        // Append audit entry for deposit.
        Self::append_audit_log(&env, AuditAction::FeeDeposit, &token, amount, &market);

        // INTERACTIONS
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&market, &env.current_contract_address(), &amount);

        boxmeout_shared::emit_fee_deposited(&env, market, token, amount);
        Ok(())
    }

    /// Receives a fee from a registered market and accumulates it per market id.
    ///
    /// # Errors
    /// - `MarketNotApproved`: caller is not registered
    pub fn receive_fee(
        env: Env,
        market: Address,
        market_id: u64,
        token: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        // CHECKS
        market.require_auth();
        let markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market.clone()) {
            return Err(ContractError::MarketNotApproved);
        }

        // EFFECTS — update per-token total and per-market breakdown
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

        // Audit the deposit.
        Self::append_audit_log(&env, AuditAction::FeeDeposit, &token, amount, &market);

        // INTERACTIONS — emit event (assumes token was already transferred by Market)
        boxmeout_shared::emit_fee_deposited(&env, market, token, amount);
        Ok(())
    }

    /// Withdraws accumulated fees with:
    ///   - A per-transaction cap (WITHDRAWAL_LIMIT)
    ///   - A daily cumulative cap (WITHDRAWAL_LIMIT × 5)
    ///   - A concurrency lock that prevents double-extraction
    ///   - An immutable audit log entry on every successful withdrawal
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    /// - `WithdrawalsPaused`: Withdrawals flag is true
    /// - `BelowMinimum`: Withdrawal amount is below minimum (1 XLM)
    /// - `DailyWithdrawalLimitExceeded`: Single-tx limit exceeded
    /// - `DailyCapReached`: Cumulative daily cap exceeded
    /// - `InsufficientBalance`: Not enough fees accumulated
    /// - `FeeExtractionInProgress`: Concurrent extraction attempt rejected
    ///
    /// # Security (CEI)
    /// 1. CHECKS: require_auth, lock, limits, balance
    /// 2. EFFECTS: decrement fees + update daily tracker + audit log
    /// 3. INTERACTIONS: token transfer last; lock released after transfer
    pub fn withdraw_fees(
        env: Env,
        admin: Address,
        token: Address,
        amount: i128,
        destination: Address,
    ) -> Result<(), ContractError> {
        // CHECKS — auth first, then lock acquisition
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        // Acquire the extraction lock.  Any concurrent invocation will see the
        // flag set and immediately return FeeExtractionInProgress.
        Self::acquire_extraction_lock(&env)?;

        // Check paused flag.
        let paused: bool = env.storage().persistent().get(&WITHDRAWALS_PAUSED).unwrap_or(false);
        if paused {
            Self::release_extraction_lock(&env);
            return Err(ContractError::WithdrawalsPaused);
        }

        // Check minimum withdrawal amount.
        if amount < MIN_WITHDRAWAL {
            Self::release_extraction_lock(&env);
            return Err(ContractError::BelowMinimum);
        }

        // Per-transaction limit check.
        let limit: i128 = env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0);
        if amount > limit {
            Self::release_extraction_lock(&env);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        // Daily cumulative cap check + update (writes if it passes).
        if let Err(e) = Self::check_and_update_daily_cap(&env, amount, limit) {
            Self::release_extraction_lock(&env);
            return Err(e);
        }

        // Balance check.
        let mut fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));
        let balance = fees.get(token.clone()).unwrap_or(0);
        if balance < amount {
            // Roll back the daily total we just incremented.
            let bucket = Self::day_bucket(&env);
            let mut daily: Map<u64, i128> = env
                .storage().persistent()
                .get(&DAILY_WITHDRAWN)
                .unwrap_or_else(|| Map::new(&env));
            let today_total = daily.get(bucket).unwrap_or(0);
            daily.set(bucket, today_total.saturating_sub(amount));
            env.storage().persistent().set(&DAILY_WITHDRAWN, &daily);
            Self::release_extraction_lock(&env);
            return Err(ContractError::InsufficientBalance);
        }

        // EFFECTS
        fees.set(token.clone(), balance - amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        // Append immutable audit entry.
        Self::append_audit_log(&env, AuditAction::FeeWithdrawal, &token, amount, &admin);

        // INTERACTIONS — transfer then release lock.
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        Self::release_extraction_lock(&env);
        boxmeout_shared::emit_fee_withdrawn(&env, token, amount, destination);
        Ok(())
    }

    /// Registers a market address. Callable only by the Factory address stored at initialization.
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

    /// Returns true if the address is a registered market.
    pub fn is_registered_market(env: Env, market_address: Address) -> bool {
        let markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        markets.contains(market_address)
    }

    /// Returns the accumulated fees for a specific token.
    pub fn get_accumulated_fees(env: Env, token: Address) -> i128 {
        let fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));
        fees.get(token).unwrap_or(0)
    }

    /// Returns the total amount withdrawn today.
    pub fn get_daily_withdrawal_amount(env: Env) -> i128 {
        let bucket = Self::day_bucket(&env);
        let daily: Map<u64, i128> =
            env.storage().persistent().get(&DAILY_WITHDRAWN).unwrap_or_else(|| Map::new(&env));
        daily.get(bucket).unwrap_or(0)
    }

    /// Returns the remaining daily withdrawal allowance for today.
    pub fn get_daily_remaining(env: Env) -> i128 {
        let limit: i128 = env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0);
        let daily_cap = limit.saturating_mul(5);
        let bucket = Self::day_bucket(&env);
        let daily: Map<u64, i128> = env
            .storage().persistent()
            .get(&DAILY_WITHDRAWN)
            .unwrap_or_else(|| Map::new(&env));
        let today_total = daily.get(bucket).unwrap_or(0);
        daily_cap.saturating_sub(today_total)
    }

    /// Returns the full immutable audit log.
    pub fn get_audit_log(env: Env) -> Vec<AuditEntry> {
        env.storage().persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns how many audit entries are stored.
    pub fn get_audit_log_len(env: Env) -> u32 {
        let log: Vec<AuditEntry> = env
            .storage().persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(&env));
        log.len()
    }

    /// Updates the per-transaction withdrawal limit.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
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

    /// Pauses all withdrawals.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn pause_withdrawals(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &true);
        Ok(())
    }

    /// Resumes withdrawals.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn unpause_withdrawals(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &false);
        Ok(())
    }

    /// Emergency drain of all accumulated fees for a token.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    ///
    /// # Security (CEI)
    /// 1. CHECKS: require_auth, admin check, lock
    /// 2. EFFECTS: zero ACCUMULATED_FEES[token] + audit log
    /// 3. INTERACTIONS: token transfer last; lock released after transfer
    pub fn emergency_drain(
        env: Env,
        admin: Address,
        token: Address,
    ) -> Result<(), ContractError> {
        // CHECKS
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        Self::acquire_extraction_lock(&env)?;

        let mut fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));
        let balance = fees.get(token.clone()).unwrap_or(0);

        // EFFECTS
        fees.set(token.clone(), 0i128);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        // Append immutable audit entry.
        Self::append_audit_log(&env, AuditAction::EmergencyDrain, &token, balance, &admin);

        // INTERACTIONS
        if balance > 0 {
            let token_client = token::Client::new(&env, &token);
            token_client.transfer(&env.current_contract_address(), &admin, &balance);
        }

        Self::release_extraction_lock(&env);
        boxmeout_shared::emit_emergency_drain(&env, token, balance, admin);
        Ok(())
    }
}

// ============================================================
// Tests for pre-existing behaviour (updated to use 4-arg initialize)
// ============================================================
#[cfg(test)]
mod tests {
    use soroban_sdk::{
        testutils::{Address as _, Events},
        token::StellarAssetClient,
        Address, Env, Symbol,
    };

    use super::{Treasury, TreasuryClient};

    /// Full 4-arg setup used by new and updated tests.
    fn setup() -> (Env, TreasuryClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin   = Address::generate(&env);
        let market  = Address::generate(&env);
        let bet_tok = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &bet_tok, &factory, &10_000_000_i128);
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

    #[test]
    #[should_panic]
    fn revoke_market_requires_admin() {
        let (env, client, admin, market) = setup();
        let non_admin = Address::generate(&env);
        client.approve_market(&admin, &market);
        client.revoke_market(&non_admin, &market);
    }

    // ── emergency_drain ───────────────────────────────────────────────────────

    fn setup_with_deposit(
        amount: i128,
    ) -> (Env, TreasuryClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &contract_id);
        let admin   = Address::generate(&env);
        let market  = Address::generate(&env);
        let bet_tok = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &bet_tok, &factory, &10_000_000_i128);

        let token = setup_token(&env, &admin, &market, amount);
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
    fn emergency_drain_zeros_accumulated_fees() {
        let (_env, client, admin, _market, token) = setup_with_deposit(1_000_000);
        assert_eq!(client.get_accumulated_fees(&token), 1_000_000);
        client.emergency_drain(&admin, &token);
        assert_eq!(client.get_accumulated_fees(&token), 0);
    }

    #[test]
    fn emergency_drain_emits_event_with_correct_data() {
        let (env, client, admin, _market, token) = setup_with_deposit(250_000);
        client.emergency_drain(&admin, &token);
        let events = env.events().all();
        let last = events.last().unwrap();
        let topic_sym: soroban_sdk::Symbol =
            soroban_sdk::TryFromVal::try_from_val(&env, &last.1.get(0).unwrap()).unwrap();
        assert_eq!(topic_sym, Symbol::new(&env, "emergency_drain"));
        let (ev_token, ev_amount, ev_admin): (Address, i128, Address) =
            soroban_sdk::TryFromVal::try_from_val(&env, &last.2).unwrap();
        assert_eq!(ev_token, token);
        assert_eq!(ev_amount, 250_000_i128);
        assert_eq!(ev_admin, admin);
    }

    #[test]
    fn emergency_drain_non_admin_returns_unauthorized() {
        let (env, client, _admin, _market, token) = setup_with_deposit(100_000);
        let non_admin = Address::generate(&env);
        let result = client.try_emergency_drain(&non_admin, &token);
        assert!(result.is_err());
    }
}

// ============================================================
// deposit_fees tests
// ============================================================
#[cfg(test)]
mod deposit_fees_tests {
    use soroban_sdk::{
        testutils::{Address as _, Events},
        token::StellarAssetClient,
        Address, Env, Symbol,
    };
    use super::{Treasury, TreasuryClient};

    fn setup() -> (Env, TreasuryClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id     = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin  = Address::generate(&env);
        let market = Address::generate(&env);
        let bet_tok = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &bet_tok, &factory, &10_000_000_i128);
        let token = env.register_stellar_asset_contract(admin.clone());
        StellarAssetClient::new(&env, &token).mint(&market, &10_000_000_i128);
        (env, client, admin, market, token)
    }

    #[test]
    fn non_approved_caller_returns_market_not_approved() {
        let (_env, client, _admin, market, token) = setup();
        let result = client.try_deposit_fees(&market, &token, &100_i128);
        assert!(result.is_err());
    }

    #[test]
    fn balance_accumulates_across_multiple_deposits() {
        let (_env, client, admin, market, token) = setup();
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &300_000_i128);
        client.deposit_fees(&market, &token, &700_000_i128);
        assert_eq!(client.get_accumulated_fees(&token), 1_000_000_i128);
    }

    #[test]
    fn fee_deposited_event_emitted_with_correct_payload() {
        let (env, client, admin, market, token) = setup();
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &500_000_i128);
        let events = env.events().all();
        // The last event is fee_deposited (audit_log is emitted just before it).
        let last = events.last().unwrap();
        let topic_sym: Symbol =
            soroban_sdk::TryFromVal::try_from_val(&env, &last.1.get(0).unwrap()).unwrap();
        assert_eq!(topic_sym, Symbol::new(&env, "fee_deposited"));
        let (ev_market, ev_token, ev_amount): (Address, Address, i128) =
            soroban_sdk::TryFromVal::try_from_val(&env, &last.2).unwrap();
        assert_eq!(ev_market, market);
        assert_eq!(ev_token, token);
        assert_eq!(ev_amount, 500_000_i128);
    }
}

// ============================================================
// initialize tests
// ============================================================
#[cfg(test)]
mod initialize_tests {
    use soroban_sdk::{testutils::Address as _, Address, Env};
    use super::{Treasury, TreasuryClient};

    fn setup_client(env: &Env) -> (TreasuryClient<'static>, Address) {
        env.mock_all_auths();
        let id     = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(env, &id);
        let admin  = Address::generate(env);
        let bet_tok = Address::generate(env);
        let factory = Address::generate(env);
        client.initialize(&admin, &bet_tok, &factory, &1_000_000i128);
        (client, admin)
    }

    #[test]
    fn test_initialize_stores_correct_state() {
        let env = Env::default();
        let (client, _admin) = setup_client(&env);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
        let token = Address::generate(&env);
        assert_eq!(client.get_accumulated_fees(&token), 0);
    }

    #[test]
    fn test_initialize_second_call_returns_already_initialized() {
        let env = Env::default();
        let (client, admin) = setup_client(&env);
        let bet_tok = Address::generate(&env);
        let factory = Address::generate(&env);
        let result = client.try_initialize(&admin, &bet_tok, &factory, &1_000_000i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_initialize_withdrawal_limit_enforced() {
        let env = Env::default();
        let (client, admin) = setup_client(&env);
        let token = Address::generate(&env);
        let dest  = Address::generate(&env);
        // Withdrawal above the per-tx limit must fail.
        let result = client.try_withdraw_fees(&admin, &token, &1_000_001i128, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn test_initialize_accumulated_fees_empty() {
        let env = Env::default();
        let (client, _admin) = setup_client(&env);
        let token1 = Address::generate(&env);
        let token2 = Address::generate(&env);
        assert_eq!(client.get_accumulated_fees(&token1), 0);
        assert_eq!(client.get_accumulated_fees(&token2), 0);
    }

    #[test]
    fn test_initialize_daily_withdrawn_empty() {
        let env = Env::default();
        let (client, _admin) = setup_client(&env);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
    }

    #[test]
    fn test_audit_log_empty_after_initialize() {
        let env = Env::default();
        let (client, _admin) = setup_client(&env);
        assert_eq!(client.get_audit_log_len(), 0);
    }
}

// ============================================================
// treasury lifecycle tests
// ============================================================
#[cfg(test)]
mod treasury_lifecycle_tests {
    use soroban_sdk::{
        testutils::Address as _,
        token::StellarAssetClient,
        Address, Env,
    };
    use super::{Treasury, TreasuryClient};

    fn setup(env: &Env, limit: i128) -> (TreasuryClient<'static>, Address, Address, Address) {
        env.mock_all_auths();
        let id     = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(env, &id);
        let admin  = Address::generate(env);
        let market = Address::generate(env);
        let bet_tok = Address::generate(env);
        let factory = Address::generate(env);
        client.initialize(&admin, &bet_tok, &factory, &limit);
        let token = env.register_stellar_asset_contract(admin.clone());
        (client, admin, market, token)
    }

    #[test]
    fn test_fee_receipt_from_registered_market() {
        let env = Env::default();
        let (client, admin, market, token) = setup(&env, 10_000_000);
        StellarAssetClient::new(&env, &token).mint(&market, &500_000i128);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &500_000i128);
        assert_eq!(client.get_accumulated_fees(&token), 500_000);
    }

    #[test]
    fn test_fee_rejected_from_unregistered_market() {
        let env = Env::default();
        let (client, _admin, market, token) = setup(&env, 10_000_000);
        let result = client.try_deposit_fees(&market, &token, &100i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_withdrawal_success() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_accumulated_fees(&token), 0);
        assert_eq!(soroban_sdk::token::Client::new(&env, &token).balance(&dest), limit);
    }

    #[test]
    fn test_withdrawal_insufficient_balance() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &100_000i128);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &100_000i128);
        let dest = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &limit, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn test_pause_withdrawals_by_zeroing_limit() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);
        client.update_withdrawal_limit(&admin, &0i128);
        let dest   = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &1i128, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn test_unpause_withdrawals_by_restoring_limit() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);
        client.update_withdrawal_limit(&admin, &0i128);
        client.update_withdrawal_limit(&admin, &limit);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_accumulated_fees(&token), 0);
    }

    #[test]
    fn test_non_admin_withdrawal_rejected() {
        let env = Env::default();
        let (client, _admin, _market, token) = setup(&env, 10_000_000);
        let non_admin = Address::generate(&env);
        let dest      = Address::generate(&env);
        let result    = client.try_withdraw_fees(&non_admin, &token, &1i128, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn test_withdrawal_below_minimum_rejected() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);
        let dest   = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &9_999_999i128, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn test_withdrawal_at_minimum_accepted() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert_eq!(client.get_accumulated_fees(&token), limit - 10_000_000i128);
        assert_eq!(soroban_sdk::token::Client::new(&env, &token).balance(&dest), 10_000_000i128);
    }
}

// ============================================================
// Task 11: Daily Limits, Concurrency Guard, and Audit Trail tests
// ============================================================
#[cfg(test)]
mod task11_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::StellarAssetClient,
        Address, Env,
    };
    use boxmeout_shared::types::AuditAction;

    use super::{Treasury, TreasuryClient};

    const LIMIT: i128   = 10_000_000; // 10 XLM — per-tx cap
    const DAILY_CAP: i128 = 50_000_000; // LIMIT * 5

    /// Seed: initialize + approve + deposit `deposit_amount` into the contract.
    fn setup_funded(
        deposit_amount: i128,
    ) -> (Env, TreasuryClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id      = env.register_contract(None, Treasury);
        let client  = TreasuryClient::new(&env, &id);
        let admin   = Address::generate(&env);
        let market  = Address::generate(&env);
        let bet_tok = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &bet_tok, &factory, &LIMIT);

        let token = env.register_stellar_asset_contract(admin.clone());
        StellarAssetClient::new(&env, &token).mint(&market, &deposit_amount);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &deposit_amount);

        (env, client, admin, market, token)
    }

    // ── Daily cap enforcement ─────────────────────────────────────────────────

    /// Five withdrawals of LIMIT each — all within the daily cap.
    #[test]
    fn test_daily_cap_allows_five_withdrawals() {
        let total   = LIMIT * 5;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        for _ in 0..5 {
            client.withdraw_fees(&admin, &token, &LIMIT, &dest);
        }
        assert_eq!(client.get_accumulated_fees(&token), 0);
        assert_eq!(client.get_daily_withdrawal_amount(), DAILY_CAP);
    }

    /// Sixth withdrawal in the same day bucket must fail with DailyCapReached.
    #[test]
    fn test_daily_cap_blocks_sixth_withdrawal() {
        let total   = LIMIT * 6;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        for _ in 0..5 {
            client.withdraw_fees(&admin, &token, &LIMIT, &dest);
        }
        // Sixth must be rejected.
        let result = client.try_withdraw_fees(&admin, &token, &LIMIT, &dest);
        assert!(result.is_err());
    }

    /// After midnight (new day bucket), the cap resets.
    #[test]
    fn test_daily_cap_resets_next_day() {
        let total   = LIMIT * 10; // enough for two full days
        let (env, client, admin, market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        // Exhaust today's cap.
        for _ in 0..5 {
            client.withdraw_fees(&admin, &token, &LIMIT, &dest);
        }
        let result = client.try_withdraw_fees(&admin, &token, &LIMIT, &dest);
        assert!(result.is_err(), "should be blocked on day 0");

        // Advance ledger timestamp by 1 day (86400 seconds).
        let ts = env.ledger().timestamp();
        env.ledger().set(LedgerInfo {
            timestamp:              ts + 86_400,
            protocol_version:       20,
            sequence_number:        env.ledger().sequence(),
            network_id:             Default::default(),
            base_reserve:           10,
            min_temp_entry_ttl:     10,
            min_persistent_entry_ttl: 10,
            max_entry_ttl:          3_110_400,
        });

        // Replenish the treasury for day 2.
        StellarAssetClient::new(&env, &token).mint(&market, &(LIMIT * 5));
        client.deposit_fees(&market, &token, &(LIMIT * 5));

        // Should now succeed (new day bucket).
        client.withdraw_fees(&admin, &token, &LIMIT, &dest);
    }

    /// get_daily_remaining accurately reflects what is left in the day bucket.
    #[test]
    fn test_get_daily_remaining_tracks_correctly() {
        let total   = LIMIT * 5;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        assert_eq!(client.get_daily_remaining(), DAILY_CAP);

        client.withdraw_fees(&admin, &token, &LIMIT, &dest);
        assert_eq!(client.get_daily_remaining(), DAILY_CAP - LIMIT);

        client.withdraw_fees(&admin, &token, &LIMIT, &dest);
        assert_eq!(client.get_daily_remaining(), DAILY_CAP - 2 * LIMIT);
    }

    // ── Concurrency guard (fee extraction lock) ───────────────────────────────

    /// A successful withdrawal should NOT leave the lock set after completion.
    /// This is verified by immediately calling withdraw_fees again — if the
    /// lock were stuck the second call would return FeeExtractionInProgress.
    #[test]
    fn test_lock_released_after_successful_withdrawal() {
        let total   = LIMIT * 10;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        // Both calls must succeed — the lock is released between them.
        client.withdraw_fees(&admin, &token, &LIMIT, &dest);
        client.withdraw_fees(&admin, &token, &LIMIT, &dest);
    }

    /// A successful emergency_drain should NOT leave the lock set.
    #[test]
    fn test_lock_released_after_emergency_drain() {
        let (env, client, admin, market, token) = {
            let env = Env::default();
            env.mock_all_auths();
            let id      = env.register_contract(None, Treasury);
            let client  = TreasuryClient::new(&env, &id);
            let admin   = Address::generate(&env);
            let market  = Address::generate(&env);
            let bet_tok = Address::generate(&env);
            let factory = Address::generate(&env);
            client.initialize(&admin, &bet_tok, &factory, &LIMIT);
            let token = env.register_stellar_asset_contract(admin.clone());
            StellarAssetClient::new(&env, &token).mint(&market, &(LIMIT * 2));
            client.approve_market(&admin, &market);
            (env, client, admin, market, token)
        };

        // Deposit in two rounds then drain twice (second drain on zero balance).
        client.deposit_fees(&market, &token, &LIMIT);
        client.emergency_drain(&admin, &token);
        // Second drain — balance is 0 but should not deadlock on the lock.
        client.deposit_fees(&market, &token, &LIMIT);
        client.emergency_drain(&admin, &token);
    }

    // ── Audit log integrity ───────────────────────────────────────────────────

    /// deposit_fees appends a FeeDeposit audit entry.
    #[test]
    fn test_audit_log_records_fee_deposit() {
        let total   = LIMIT;
        let (_env, client, _admin, _market, _token) = setup_funded(total);

        // One deposit happened in setup_funded.
        let len = client.get_audit_log_len();
        assert!(len >= 1, "expected at least one audit entry, got {}", len);

        let log = client.get_audit_log();
        let entry = log.get(len - 1).unwrap();
        assert_eq!(entry.action, AuditAction::FeeDeposit);
        assert_eq!(entry.amount, total);
    }

    /// withdraw_fees appends a FeeWithdrawal audit entry.
    #[test]
    fn test_audit_log_records_fee_withdrawal() {
        let total   = LIMIT * 5;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);
        let before  = client.get_audit_log_len();

        client.withdraw_fees(&admin, &token, &LIMIT, &dest);

        let after = client.get_audit_log_len();
        assert_eq!(after, before + 1);

        let log   = client.get_audit_log();
        let entry = log.get(after - 1).unwrap();
        assert_eq!(entry.action, AuditAction::FeeWithdrawal);
        assert_eq!(entry.amount, LIMIT);
        assert_eq!(entry.actor, admin);
        assert_eq!(entry.token, token);
    }

    /// emergency_drain appends an EmergencyDrain audit entry.
    #[test]
    fn test_audit_log_records_emergency_drain() {
        let total   = LIMIT;
        let (_env, client, admin, _market, token) = setup_funded(total);
        let before  = client.get_audit_log_len();

        client.emergency_drain(&admin, &token);

        let after = client.get_audit_log_len();
        assert_eq!(after, before + 1);

        let log   = client.get_audit_log();
        let entry = log.get(after - 1).unwrap();
        assert_eq!(entry.action, AuditAction::EmergencyDrain);
        assert_eq!(entry.amount, total);
        assert_eq!(entry.actor, admin);
    }

    /// When the daily cap is hit, withdraw_fees returns DailyCapReached error.
    ///
    /// Note: Soroban reverts all storage changes (including audit log appends)
    /// on a failed invocation, so we cannot assert a persisted audit entry for
    /// the cap-hit case.  The error code is the observable signal.
    #[test]
    fn test_daily_cap_hit_returns_error() {
        let total   = LIMIT * 6;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        for _ in 0..5 {
            client.withdraw_fees(&admin, &token, &LIMIT, &dest);
        }
        // The sixth withdrawal must be rejected.
        let result = client.try_withdraw_fees(&admin, &token, &LIMIT, &dest);
        assert!(result.is_err(), "expected DailyCapReached error on 6th withdrawal");

        // Audit log should only contain: 1 deposit + 5 successful withdrawals.
        let log = client.get_audit_log();
        let len = log.len();
        assert_eq!(len, 6, "expected 6 audit entries (1 deposit + 5 withdrawals)");
    }

    /// Audit log is append-only: entries from previous operations persist.
    #[test]
    fn test_audit_log_is_append_only() {
        let total   = LIMIT * 5;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        for _ in 0..3 {
            client.withdraw_fees(&admin, &token, &LIMIT, &dest);
        }

        // All prior entries must still be present.
        let log = client.get_audit_log();
        let len = log.len();
        // 1 deposit + 3 withdrawals = at least 4 entries.
        assert!(len >= 4, "expected at least 4 audit entries, got {}", len);
        // Verify none of the old entries are overwritten: each withdrawal entry
        // should carry the correct action type.
        let mut withdrawal_count = 0u32;
        for i in 0..len {
            if log.get(i).unwrap().action == AuditAction::FeeWithdrawal {
                withdrawal_count += 1;
            }
        }
        assert_eq!(withdrawal_count, 3);
    }

    // ── pause / unpause ───────────────────────────────────────────────────────

    #[test]
    fn test_pause_blocks_withdrawals() {
        let total   = LIMIT * 5;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        client.pause_withdrawals(&admin);
        let result = client.try_withdraw_fees(&admin, &token, &LIMIT, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn test_unpause_restores_withdrawals() {
        let total   = LIMIT * 5;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        client.pause_withdrawals(&admin);
        client.unpause_withdrawals(&admin);
        client.withdraw_fees(&admin, &token, &LIMIT, &dest);
        assert_eq!(client.get_accumulated_fees(&token), total - LIMIT);
    }

    // ── day_bucket field in audit entries ────────────────────────────────────

    #[test]
    fn test_audit_entry_day_bucket_matches_current_day() {
        let total   = LIMIT * 5;
        let (env, client, admin, _market, token) = setup_funded(total);
        let dest    = Address::generate(&env);

        let expected_bucket = env.ledger().timestamp() / 86_400;
        client.withdraw_fees(&admin, &token, &LIMIT, &dest);

        let log   = client.get_audit_log();
        let last  = log.get(log.len() - 1).unwrap();
        assert_eq!(last.day_bucket, expected_bucket);
    }
}
