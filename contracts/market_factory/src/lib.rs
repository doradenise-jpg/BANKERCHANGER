#![no_std]
//! ============================================================
//! BANKERCHANGER — MarketFactory Contract (Security-Audited)
//! ============================================================

extern crate alloc;

use soroban_sdk::{contract, contractclient, contractimpl, Address, BytesN, Env, Map, Vec};

use boxmeout_shared::{
    errors::ContractError,
    types::{
        BetRecord, FactoryConfig, FightDetails, MarketConfig, MarketState, MarketStatus,
        UserPosition,
    },
};

const MARKET_COUNT: &str = "MARKET_COUNT";
const MARKET_MAP: &str = "MARKET_MAP";
const ADMIN: &str = "ADMIN";
const PENDING_ADMIN: &str = "PENDING_ADMIN";
const PENDING_ADMIN_EXPIRY: &str = "PENDING_ADMIN_EXPIRY";
const ADMIN_TIMELOCK: &str = "ADMIN_TIMELOCK";
const PENDING_ADMIN_UNLOCK: &str = "PENDING_ADMIN_UNLOCK";
/// Two-step admin transfer must be accepted within this window (7 days) or it expires.
const PENDING_ADMIN_TTL_SECS: u64 = 604_800;
/// Default 24-hour time-lock between propose_admin and accept_admin (configurable).
const DEFAULT_ADMIN_TIMELOCK_SECS: u64 = 86_400;
/// Minimum number of seconds between "now" and a fight's scheduled_at.
/// A fight must be at least 1 hour (3 600 s) in the future so that a meaningful
/// betting window can open before the market locks.
pub(crate) const MIN_MARKET_DURATION: u64 = 3_600;
const ORACLE_WHITELIST: &str = "ORACLE_WHITELIST";
const PAUSED: &str = "PAUSED";
const DEFAULT_CONFIG: &str = "DEFAULT_CONFIG";
const TREASURY: &str = "TREASURY";
const MARKET_WASM_HASH: &str = "MARKET_WASM_HASH";
const OPEN_MARKETS: &str = "OPEN_MARKETS";

#[contractclient(name = "MarketClient")]
pub trait MarketInterface {
    fn initialize(
        env: Env,
        factory: Address,
        market_id: u64,
        fight: FightDetails,
        config: MarketConfig,
        treasury: Address,
    ) -> Result<(), ContractError>;
    fn get_bets_by_address(env: Env, bettor: Address) -> Vec<BetRecord>;
    fn get_state(env: Env) -> Result<MarketState, ContractError>;
    fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError>;
    fn emergency_pause(env: Env, admin: Address) -> Result<(), ContractError>;
    fn emergency_unpause(env: Env, admin: Address) -> Result<(), ContractError>;
    fn get_status(env: Env) -> Result<MarketStatus, ContractError>;
    fn get_market_status(env: Env) -> Result<MarketStatus, ContractError>;
    fn refund_expired(env: Env, market_id: u64) -> Result<(), ContractError>;
}

#[contract]
pub struct MarketFactory;

impl MarketFactory {
    fn require_admin(env: &Env, caller: &Address) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .persistent()
            .get(&ADMIN)
            .ok_or(ContractError::NotAdmin)?;
        if *caller != admin {
            return Err(ContractError::NotAdmin);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), ContractError> {
        let paused: bool = env.storage().persistent().get(&PAUSED).unwrap_or(false);
        if paused {
            return Err(ContractError::FactoryPaused);
        }
        Ok(())
    }
}

#[contractimpl]
impl MarketFactory {
    /// Initializes the factory with admin, treasury, primary oracle, and factory config.
    ///
    /// # Errors
    /// - `AlreadyInitialized`: Factory has already been initialized
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        oracle: Address,
        oracle_raw_key: BytesN<32>,
        config: FactoryConfig,
    ) -> Result<(), ContractError> {
        // CHECKS
        if env.storage().persistent().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        // EFFECTS
        env.storage().persistent().set(&ADMIN, &admin);
        env.storage().persistent().set(&TREASURY, &treasury);

        let mut oracles: Map<Address, BytesN<32>> = Map::new(&env);
        oracles.set(oracle, oracle_raw_key);
        env.storage().persistent().set(&ORACLE_WHITELIST, &oracles);

        env.storage().persistent().set(&PAUSED, &false);
        env.storage().persistent().set(&MARKET_COUNT, &0u64);
        env.storage()
            .persistent()
            .set(&MARKET_MAP, &Map::<u64, Address>::new(&env));

        let default_config = MarketConfig {
            min_bet_amount: config.default_min_bet,
            max_bet: config.default_max_bet,
            max_bet_share_bps: 2_000,
            fee_bps: config.default_fee_bps,
            lock_before_secs: config.default_lock_before_secs,
            resolution_window: config.default_resolution_window,
            tier: 0,
            dispute_cooldown_ledgers: 720,
        };
        env.storage()
            .persistent()
            .set(&DEFAULT_CONFIG, &default_config);

        // Initialize with zero hash; admin must call update_market_wasm to set it
        let zero_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        env.storage()
            .persistent()
            .set(&MARKET_WASM_HASH, &zero_hash);
        env.storage()
            .persistent()
            .set(&OPEN_MARKETS, &Vec::<u64>::new(&env));
        env.storage()
            .persistent()
            .set(&ADMIN_TIMELOCK, &DEFAULT_ADMIN_TIMELOCK_SECS);

        env.storage().instance().extend_ttl(50_000, 100_000);
        env.storage().persistent().extend_ttl(&ADMIN, 50_000, 100_000);
        env.storage().persistent().extend_ttl(&TREASURY, 50_000, 100_000);
        env.storage().persistent().extend_ttl(&ORACLE_WHITELIST, 50_000, 100_000);
        env.storage().persistent().extend_ttl(&PAUSED, 50_000, 100_000);
        env.storage().persistent().extend_ttl(&MARKET_COUNT, 50_000, 100_000);
        env.storage().persistent().extend_ttl(&MARKET_MAP, 50_000, 100_000);
        env.storage().persistent().extend_ttl(&DEFAULT_CONFIG, 50_000, 100_000);
        env.storage().persistent().extend_ttl(&MARKET_WASM_HASH, 50_000, 100_000);
        env.storage().persistent().extend_ttl(&OPEN_MARKETS, 50_000, 100_000);
        Ok(())
    }

    /// Updates the Market wasm hash used for new deployments.
    /// Only admin can call this. Existing markets are unaffected.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn update_market_wasm(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage()
            .persistent()
            .set(&MARKET_WASM_HASH, &new_wasm_hash);
        Ok(())
    }

    /// Creates a new market for a boxing match.
    ///
    /// # Errors
    /// - `InvalidTimeRange`: Fight start time is in the past
    /// - `InvalidMarketParameters`: Fighter names are missing or market config is invalid
    /// - `BetTooLow`: min_bet is zero
    /// - `InvalidMarketParameters`: fee_bps exceeds 1000
    /// - `FactoryPaused`: Factory is paused
    /// - `WasmHashNotSet`: Admin has not yet called update_market_wasm
    pub fn create_market(
        env: Env,
        caller: Address,
        fight: FightDetails,
        config: MarketConfig,
        fee_bps: Option<u32>,
    ) -> Result<u64, ContractError> {
        // CHECKS — auth and pause guard first
        caller.require_auth();
        Self::require_not_paused(&env)?;

        if fight.scheduled_at <= env.ledger().timestamp() {
            return Err(ContractError::InvalidTimeRange);
        }
        // Enforce a minimum betting window: the fight must be scheduled at least
        // MIN_MARKET_DURATION seconds from now so bettors have time to participate.
        if fight.scheduled_at <= env.ledger().timestamp().saturating_add(MIN_MARKET_DURATION) {
            return Err(ContractError::InvalidFightDate);
        }
        if fight.fighter_a.len() == 0 || fight.fighter_b.len() == 0 {
            return Err(ContractError::InvalidMarketParameters);
        }

        // Validate fighter_a != fighter_b (case-insensitive)
        if fight.fighter_a.len() == fight.fighter_b.len() {
            let len = fight.fighter_a.len() as usize;
            let mut bytes_a = alloc::vec![0u8; len];
            let mut bytes_b = alloc::vec![0u8; len];
            fight.fighter_a.copy_into_slice(&mut bytes_a);
            fight.fighter_b.copy_into_slice(&mut bytes_b);
            let mut is_dup = true;
            for i in 0..len {
                if bytes_a[i].to_ascii_lowercase() != bytes_b[i].to_ascii_lowercase() {
                    is_dup = false;
                    break;
                }
            }
            if is_dup {
                return Err(ContractError::DuplicateFighterName);
            }
        }

        // ── Config validation ─────────────────────────────
        if config.min_bet_amount == 0 {
            return Err(ContractError::BelowMinimum);
        }
        if config.max_bet < config.min_bet_amount {
            return Err(ContractError::InvalidMarketParameters);
        }
        if config.max_bet_share_bps == 0 || config.max_bet_share_bps > 10_000 {
            return Err(ContractError::InvalidMarketParameters);
        }
        // Tier 0 = untiered/default; any positive u32 is valid (e.g. 18, 20, etc.)
        // No upper bound enforced — factory admin is responsible for tier assignments.

        // Resolve effective fee: use override if provided (capped at 1000 bps), else config value
        let effective_fee_bps = match fee_bps {
            Some(f) => {
                if f > 1000 {
                    return Err(ContractError::InvalidMarketParameters);
                }
                f
            }
            None => {
                if config.fee_bps > 1000 {
                    return Err(ContractError::InvalidMarketParameters);
                }
                config.fee_bps
            }
        };

        let mut effective_config = config;
        effective_config.fee_bps = effective_fee_bps;

        let market_id: u64 = env.storage().persistent().get(&MARKET_COUNT).unwrap_or(0);
        let new_count = market_id + 1;

        // ── Validate WASM hash is set ───────────────────────
        let wasm_hash: BytesN<32> = env
            .storage()
            .persistent()
            .get(&MARKET_WASM_HASH)
            .unwrap_or_else(|| BytesN::from_array(&env, &[0u8; 32]));
        if wasm_hash == BytesN::from_array(&env, &[0u8; 32]) {
            return Err(ContractError::WasmHashNotSet);
        }

        // ── Validate treasury is set ────────────────────────
        let treasury: Address = env
            .storage()
            .persistent()
            .get(&TREASURY)
            .ok_or(ContractError::NotFactory)?;

        // Use market_id as salt so each deployment gets a unique address
        let salt = BytesN::from_array(&env, &{
            let mut arr = [0u8; 32];
            let id_bytes = market_id.to_be_bytes();
            arr[24..32].copy_from_slice(&id_bytes);
            arr
        });

        // INTERACTIONS — deploy then initialize
        let market_address = env
            .deployer()
            .with_address(env.current_contract_address(), salt)
            .deploy(wasm_hash);

        let market_client = MarketClient::new(&env, &market_address);
        market_client.initialize(
            &env.current_contract_address(),
            &market_id,
            &fight.clone(),
            &effective_config,
            &treasury,
        );

        let mut market_map: Map<u64, Address> = env
            .storage()
            .persistent()
            .get(&MARKET_MAP)
            .unwrap_or_else(|| Map::new(&env));
        market_map.set(market_id, market_address.clone());
        env.storage().persistent().set(&MARKET_MAP, &market_map);
        env.storage().persistent().set(&MARKET_COUNT, &new_count);

        // Track as open market
        let mut open_markets: Vec<u64> = env
            .storage()
            .persistent()
            .get(&OPEN_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        open_markets.push_back(market_id);
        env.storage().persistent().set(&OPEN_MARKETS, &open_markets);

        boxmeout_shared::emit_market_created(&env, market_id, market_address, fight.match_id);
        Ok(market_id)
    }

    /// Retrieves the address of a market by ID.
    ///
    /// # Errors
    /// - `MarketNotFound`: Market ID does not exist
    pub fn get_market_address(env: Env, market_id: u64) -> Result<Address, ContractError> {
        let map: Map<u64, Address> = env
            .storage()
            .persistent()
            .get(&MARKET_MAP)
            .unwrap_or_else(|| Map::new(&env));
        map.get(market_id).ok_or(ContractError::MarketNotFound)
    }

    /// Returns a paginated list of all market IDs.
    /// Capped at 100 IDs per page.
    pub fn list_market_ids(env: Env, offset: u64, limit: u32) -> Vec<u64> {
        let open: Vec<u64> = env
            .storage()
            .persistent()
            .get(&OPEN_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        let cap = if limit > 100 { 100u32 } else { limit };
        let mut result: Vec<u64> = Vec::new(&env);
        let pos = offset as u32;
        let mut fetched = 0u32;
        while (pos + fetched) < open.len() && fetched < cap {
            result.push_back(open.get(pos + fetched).unwrap());
            fetched += 1;
        }
        result
    }

    /// Lists markets with pagination, returning `(market_id, status)` pairs.
    ///
    /// - `offset`: first market ID to include (0-based)
    /// - `limit`: maximum number of results; capped at 100
    ///
    /// Markets whose state cannot be read are silently skipped.
    pub fn list_markets(env: Env, offset: u64, limit: u32) -> Vec<(u64, MarketStatus)> {
        let count: u64 = env.storage().persistent().get(&MARKET_COUNT).unwrap_or(0);
        let map: Map<u64, Address> = env
            .storage()
            .persistent()
            .get(&MARKET_MAP)
            .unwrap_or_else(|| Map::new(&env));
        let cap = if limit > 100 { 100u32 } else { limit };
        let mut result: Vec<(u64, MarketStatus)> = Vec::new(&env);

        let mut i = offset;
        let mut fetched = 0u32;
        while i < count && fetched < cap {
            if let Some(addr) = map.get(i) {
                if let Ok(Ok(state)) = MarketClient::new(&env, &addr).try_get_state() {
                    result.push_back((i, state.status));
                    fetched += 1;
                }
            }
            i += 1;
        }
        result
    }

    /// Returns the total number of markets created.
    pub fn get_market_count(env: Env) -> u64 {
        env.storage().persistent().get(&MARKET_COUNT).unwrap_or(0)
    }

    /// Returns the IDs of all currently Open markets.
    pub fn get_open_market_ids(env: Env) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&OPEN_MARKETS)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Removes a market from the open list when it is no longer Open.
    /// Callable by admin or a whitelisted oracle after locking/resolving/cancelling.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not admin or whitelisted oracle
    /// - `MarketNotFound`: Market ID does not exist
    /// - `InvalidMarketStatus`: Market is still Open
    pub fn remove_open_market(
        env: Env,
        caller: Address,
        market_id: u64,
    ) -> Result<(), ContractError> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .persistent()
            .get(&ADMIN)
            .ok_or(ContractError::NotAdmin)?;
        let oracles: Map<Address, BytesN<32>> = env
            .storage()
            .persistent()
            .get(&ORACLE_WHITELIST)
            .unwrap_or_else(|| Map::new(&env));
        if caller != admin && !oracles.contains_key(caller.clone()) {
            return Err(ContractError::NotAdmin);
        }

        // Verify market is no longer Open
        let market_map: Map<u64, Address> = env
            .storage()
            .persistent()
            .get(&MARKET_MAP)
            .unwrap_or_else(|| Map::new(&env));
        let market_address = market_map
            .get(market_id)
            .ok_or(ContractError::MarketNotFound)?;
        let state = MarketClient::new(&env, &market_address)
            .try_get_state()
            .map_err(|_| ContractError::MarketNotFound)?
            .map_err(|_| ContractError::MarketNotFound)?;
        if state.status == MarketStatus::Open {
            return Err(ContractError::MarketNotOpen);
        }

        let open: Vec<u64> = env
            .storage()
            .persistent()
            .get(&OPEN_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        let mut updated: Vec<u64> = Vec::new(&env);
        for id in open.iter() {
            if id != market_id {
                updated.push_back(id);
            }
        }
        env.storage().persistent().set(&OPEN_MARKETS, &updated);
        Ok(())
    }

    /// Adds an oracle to the whitelist with its raw Ed25519 public key.
    ///
    /// # Arguments
    /// - `oracle`: Stellar address of the oracle (G... address)
    /// - `raw_key`: Raw 32-byte Ed25519 public key corresponding to `oracle`
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn add_oracle(
        env: Env,
        admin: Address,
        oracle: Address,
        raw_key: BytesN<32>,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let mut oracles: Map<Address, BytesN<32>> = env
            .storage()
            .persistent()
            .get(&ORACLE_WHITELIST)
            .unwrap_or_else(|| Map::new(&env));
        if oracles.contains_key(oracle.clone()) {
            return Err(ContractError::OracleAlreadyWhitelisted);
        }
        oracles.set(oracle, raw_key);
        env.storage().persistent().set(&ORACLE_WHITELIST, &oracles);
        Ok(())
    }

    /// Removes an oracle from the whitelist.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    /// - `OracleNotWhitelisted`: Oracle is not in the whitelist
    pub fn remove_oracle(env: Env, admin: Address, oracle: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let mut oracles: Map<Address, BytesN<32>> = env
            .storage()
            .persistent()
            .get(&ORACLE_WHITELIST)
            .unwrap_or_else(|| Map::new(&env));
        if !oracles.contains_key(oracle.clone()) {
            return Err(ContractError::OracleNotWhitelisted);
        }
        oracles.remove(oracle);
        env.storage().persistent().set(&ORACLE_WHITELIST, &oracles);
        Ok(())
    }

    /// Returns the list of whitelisted oracle addresses.
    pub fn get_oracles(env: Env) -> Vec<Address> {
        let oracles: Map<Address, BytesN<32>> = env
            .storage()
            .persistent()
            .get(&ORACLE_WHITELIST)
            .unwrap_or_else(|| Map::new(&env));
        let mut result: Vec<Address> = Vec::new(&env);
        for (addr, _) in oracles.iter() {
            result.push_back(addr);
        }
        result
    }

    /// Returns the raw Ed25519 public key for a whitelisted oracle, or None if not found.
    pub fn get_oracle_key(env: Env, oracle: Address) -> Option<BytesN<32>> {
        let oracles: Map<Address, BytesN<32>> = env
            .storage()
            .persistent()
            .get(&ORACLE_WHITELIST)
            .unwrap_or_else(|| Map::new(&env));
        oracles.get(oracle)
    }

    /// Sets the admin timelock in seconds. Only callable by admin.
    pub fn set_admin_timelock(
        env: Env,
        admin: Address,
        timelock_secs: u64,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&ADMIN_TIMELOCK, &timelock_secs);
        Ok(())
    }

    /// Gets the current admin timelock in seconds.
    pub fn get_admin_timelock(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&ADMIN_TIMELOCK)
            .unwrap_or(DEFAULT_ADMIN_TIMELOCK_SECS)
    }

    /// Returns the pending admin nominee, if one exists.
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&PENDING_ADMIN)
    }

    /// Returns the timestamp when the pending admin transfer can be accepted.
    pub fn get_pending_admin_unlock(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&PENDING_ADMIN_UNLOCK)
            .unwrap_or(0)
    }

    /// Proposes a new admin address, starting the two-step transfer.
    ///
    /// The current admin writes the candidate to `PENDING_ADMIN` with a time-lock.
    /// Nothing changes until the candidate calls `accept_admin` after the time-lock expires.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the current admin
    pub fn propose_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), ContractError> {
        current_admin.require_auth();
        Self::require_admin(&env, &current_admin)?;

        let timelock = env
            .storage()
            .persistent()
            .get(&ADMIN_TIMELOCK)
            .unwrap_or(DEFAULT_ADMIN_TIMELOCK_SECS);
        let now = env.ledger().timestamp();
        let unlock_at = now.saturating_add(timelock);
        let expiry = now.saturating_add(PENDING_ADMIN_TTL_SECS);

        env.storage().persistent().set(&PENDING_ADMIN, &new_admin);
        env.storage().persistent().set(&PENDING_ADMIN_UNLOCK, &unlock_at);
        env.storage()
            .persistent()
            .set(&PENDING_ADMIN_EXPIRY, &expiry);
        boxmeout_shared::emit_admin_proposed(&env, current_admin, new_admin);
        Ok(())
    }

    /// Completes the two-step admin transfer.
    ///
    /// Must be called by the exact address stored in `PENDING_ADMIN`, after
    /// `PENDING_ADMIN_UNLOCK` and before `PENDING_ADMIN_EXPIRY` elapses.
    ///
    /// # Errors
    /// - `NotAdmin`: No pending proposal exists, or caller is not the pending admin
    /// - `AdminTimelockActive`: Time-lock has not yet expired
    /// - `PendingAdminExpired`: The proposal window has elapsed
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        new_admin.require_auth();

        let pending: Address = env
            .storage()
            .persistent()
            .get(&PENDING_ADMIN)
            .ok_or(ContractError::NotAdmin)?;

        if new_admin != pending {
            return Err(ContractError::NotAdmin);
        }

        let unlock_at: u64 = env
            .storage()
            .persistent()
            .get(&PENDING_ADMIN_UNLOCK)
            .unwrap_or(0);
        if env.ledger().timestamp() < unlock_at {
            return Err(ContractError::AdminTimelockActive);
        }

        let expiry: u64 = env
            .storage()
            .persistent()
            .get(&PENDING_ADMIN_EXPIRY)
            .ok_or(ContractError::NotAdmin)?;
        if env.ledger().timestamp() > expiry {
            env.storage().persistent().remove(&PENDING_ADMIN);
            env.storage().persistent().remove(&PENDING_ADMIN_UNLOCK);
            env.storage().persistent().remove(&PENDING_ADMIN_EXPIRY);
            return Err(ContractError::PendingAdminExpired);
        }

        let old_admin: Address = env
            .storage()
            .persistent()
            .get(&ADMIN)
            .ok_or(ContractError::NotAdmin)?;

        // EFFECTS
        env.storage().persistent().set(&ADMIN, &new_admin);
        env.storage().persistent().remove(&PENDING_ADMIN);
        env.storage().persistent().remove(&PENDING_ADMIN_UNLOCK);
        env.storage().persistent().remove(&PENDING_ADMIN_EXPIRY);

        boxmeout_shared::emit_admin_transferred(&env, old_admin, new_admin);
        Ok(())
    }

    /// Pauses the factory, preventing new market creation.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the admin
    pub fn pause_factory(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&PAUSED, &true);
        Ok(())
    }

    /// Unpauses the factory, allowing new market creation.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the admin
    pub fn unpause_factory(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&PAUSED, &false);
        Ok(())
    }

    /// Returns whether the factory is paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().persistent().get(&PAUSED).unwrap_or(false)
    }

    /// Pauses an individual market. Only admin can call this.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the admin
    /// - `MarketNotFound`: Market ID does not exist
    pub fn pause_market(env: Env, admin: Address, market_id: u64) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        let market_address = Self::get_market_address(env.clone(), market_id)?;
        MarketClient::new(&env, &market_address).emergency_pause(&env.current_contract_address());
        boxmeout_shared::emit_market_paused(&env, market_id, admin);
        Ok(())
    }

    /// Unpauses an individual market. Only admin can call this.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the admin
    /// - `MarketNotFound`: Market ID does not exist
    pub fn unpause_market(env: Env, admin: Address, market_id: u64) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        let market_address = Self::get_market_address(env.clone(), market_id)?;
        MarketClient::new(&env, &market_address).emergency_unpause(&env.current_contract_address());
        boxmeout_shared::emit_market_unpaused(&env, market_id, admin);
        Ok(())
    }

    /// Returns the current status of a specific market.
    ///
    /// # Errors
    /// - `MarketNotFound`: Market ID does not exist
    pub fn get_market_status(env: Env, market_id: u64) -> Result<MarketStatus, ContractError> {
        let market_address = Self::get_market_address(env.clone(), market_id)?;
        match MarketClient::new(&env, &market_address).try_get_market_status() {
            Ok(Ok(status)) => Ok(status),
            _ => Err(ContractError::MarketNotFound),
        }
    }

    /// Permissionless refund for an expired, unresolved market.
    ///
    /// # Errors
    /// - `MarketNotFound`: Market ID does not exist
    /// - `InvalidMarketStatus`: Market is not expired or already resolved
    pub fn refund_expired(env: Env, market_id: u64) -> Result<(), ContractError> {
        let market_address = Self::get_market_address(env.clone(), market_id)?;
        MarketClient::new(&env, &market_address).refund_expired(&market_id);
        Ok(())
    }

    /// Returns the registered admin address of the factory.
    ///
    /// Used by market contracts to cross-call and verify upgrade authorization.
    /// Returns the current admin (not the pending admin nominee).
    pub fn get_admin(env: Env) -> Address {
        env.storage().persistent()
            .get(&ADMIN)
            .expect("factory not initialized")
    }

    /// Returns all market IDs currently tracked as open.
    pub fn get_all_market_ids(env: Env) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&OPEN_MARKETS)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Called by a market contract to remove itself from OPEN_MARKETS when it
    /// reaches a terminal state (Resolved or Cancelled). The market_address
    /// parameter is verified against the registered market for the given
    /// market_id, so no auth check is needed — only the actual market contract
    /// can supply its own address.
    ///
    /// # Errors
    /// - `MarketNotFound`: market_id does not exist in MARKET_MAP
    /// - `MarketNotOpen`: Market is still Open (must be Resolved or Cancelled)
    pub fn cleanup_terminal_market(
        env: Env,
        market_address: Address,
        market_id: u64,
    ) -> Result<(), ContractError> {
        let market_map: Map<u64, Address> = env
            .storage()
            .persistent()
            .get(&MARKET_MAP)
            .unwrap_or_else(|| Map::new(&env));
        let stored_address = market_map
            .get(market_id)
            .ok_or(ContractError::MarketNotFound)?;
        if stored_address != market_address {
            return Err(ContractError::MarketNotFound);
        }

        let state = MarketClient::new(&env, &stored_address)
            .try_get_state()
            .map_err(|_| ContractError::MarketNotFound)?
            .map_err(|_| ContractError::MarketNotFound)?;
        if state.status == MarketStatus::Open {
            return Err(ContractError::MarketNotOpen);
        }

        let open: Vec<u64> = env
            .storage()
            .persistent()
            .get(&OPEN_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        let mut updated: Vec<u64> = Vec::new(&env);
        for id in open.iter() {
            if id != market_id {
                updated.push_back(id);
            }
        }
        env.storage().persistent().set(&OPEN_MARKETS, &updated);
        Ok(())
    }

    /// Updates the default market configuration.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the admin
    pub fn update_default_config(
        env: Env,
        admin: Address,
        new_config: MarketConfig,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        if new_config.max_bet_share_bps == 0 || new_config.max_bet_share_bps > 10_000 {
            return Err(ContractError::InvalidMarketParameters);
        }
        env.storage().persistent().set(&DEFAULT_CONFIG, &new_config);
        Ok(())
    }

    /// Retrieves all unclaimed positions for a bettor across multiple markets.
    ///
    /// # Errors
    /// - `TooManyMarkets`: More than 20 market IDs provided
    /// - `MarketNotFound`: One of the market IDs does not exist
    pub fn get_user_positions_all(
        env: Env,
        bettor: Address,
        market_ids: Vec<u64>,
    ) -> Result<Vec<UserPosition>, ContractError> {
        if market_ids.len() > 20 {
            return Err(ContractError::TooManyMarkets);
        }
        let mut positions: Vec<UserPosition> = Vec::new(&env);
        let market_map: Map<u64, Address> = env
            .storage()
            .persistent()
            .get(&MARKET_MAP)
            .unwrap_or_else(|| Map::new(&env));

        for market_id in market_ids.iter() {
            let market_address = market_map
                .get(market_id)
                .ok_or(ContractError::MarketNotFound)?;
            let market_client = MarketClient::new(&env, &market_address);
            let bets = market_client.get_bets_by_address(&bettor);
            for bet in bets.iter() {
                if bet.amount > 0 && !bet.claimed {
                    positions.push_back(UserPosition {
                        market_id: bet.market_id,
                        side: bet.side.clone(),
                        amount: bet.amount,
                    });
                }
            }
        }
        Ok(positions)
    }

    /// Upgrades all existing market contracts to a new WASM implementation.
    /// This function iterates through all open markets and calls their upgrade function.
    ///
    /// # Errors
    /// - `NotAdmin`: Caller is not the admin
    /// - `MarketNotFound`: A market ID in OPEN_MARKETS doesn't exist in MARKET_MAP
    ///
    /// # Security
    /// - Only the factory admin can call this function
    /// - State is preserved in each market contract across the upgrade
    pub fn upgrade_all_markets(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let market_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&OPEN_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        let market_map: Map<u64, Address> = env
            .storage()
            .persistent()
            .get(&MARKET_MAP)
            .unwrap_or_else(|| Map::new(&env));

        for market_id in market_ids.iter() {
            let market_address = market_map
                .get(market_id)
                .ok_or(ContractError::MarketNotFound)?;
            let market_client = MarketClient::new(&env, &market_address);
            market_client.upgrade(&admin, &new_wasm_hash);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{MarketFactory, MarketFactoryClient};
    use boxmeout_shared::types::{FactoryConfig, FightDetails, MarketConfig};
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String, Vec};

    fn setup() -> (Env, MarketFactoryClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MarketFactory);
        let client = MarketFactoryClient::new(&env, &contract_id);
        (env, client)
    }

    fn default_config() -> FactoryConfig {
        FactoryConfig {
            default_min_bet: 1_000_000,
            default_max_bet: 100_000_000_000,
            default_fee_bps: 200,
            default_lock_before_secs: 3600,
            default_resolution_window: 86400,
        }
    }

    fn sample_fight(env: &Env) -> FightDetails {
        FightDetails {
            match_id: String::from_str(env, "FIGHT-001"),
            fighter_a: String::from_str(env, "Ali"),
            fighter_b: String::from_str(env, "Frazier"),
            weight_class: String::from_str(env, "Heavyweight"),
            scheduled_at: env.ledger().timestamp() + 86400,
            venue: String::from_str(env, "Arena"),
            title_fight: true,
        }
    }

    fn sample_market_config(_env: &Env) -> MarketConfig {
        MarketConfig {
            min_bet_amount: 1_000_000,
            max_bet: 100_000_000_000,
            max_bet_share_bps: 2_000,
            fee_bps: 200,
            lock_before_secs: 3600,
            resolution_window: 86400,
            tier: 0,
            dispute_cooldown_ledgers: 0,
        }
    }

    fn init_factory(env: &Env, client: &MarketFactoryClient) {
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let oracle = Address::generate(env);
        let oracle_raw_key: BytesN<32> = BytesN::from_array(env, &[1u8; 32]);
        client.initialize(
            &admin,
            &treasury,
            &oracle,
            &oracle_raw_key,
            &default_config(),
        );
    }

    // ── initialize tests ────────────────────────────────────

    #[test]
    fn test_initialize_stores_state() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let oracle = Address::generate(&env);
        let oracle_raw_key: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);
        let config = default_config();
        let mut expected_oracles: Vec<Address> = Vec::new(&env);
        expected_oracles.push_back(oracle.clone());

        client.initialize(&admin, &treasury, &oracle, &oracle_raw_key, &config);

        assert!(!client.is_paused());
        assert_eq!(client.get_oracles(), expected_oracles);
        assert_eq!(client.get_market_count(), 0u64);
    }

    #[test]
    fn test_initialize_second_call_returns_already_initialized() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let oracle = Address::generate(&env);
        let oracle_raw_key: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);
        let config = default_config();

        client.initialize(&admin, &treasury, &oracle, &oracle_raw_key, &config);

        let result = client.try_initialize(&admin, &treasury, &oracle, &oracle_raw_key, &config);
        assert!(result.is_err());
    }

    // ── create_market validation tests ──────────────────────

    #[test]
    fn test_create_market_fails_when_paused() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let oracle = Address::generate(&env);
        let oracle_raw_key: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);
        client.initialize(
            &admin,
            &treasury,
            &oracle,
            &oracle_raw_key,
            &default_config(),
        );
        client.pause_factory(&admin);

        let caller = Address::generate(&env);
        let result = client.try_create_market(
            &caller,
            &sample_fight(&env),
            &sample_market_config(&env),
            &None,
        );
        assert!(result.is_err());
    }

    #[test]
    #[ignore = "pre-existing: env.ledger().timestamp() defaults to 0, causing subtract overflow"]
    fn test_create_market_fails_when_fight_in_past() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut fight = sample_fight(&env);
        fight.scheduled_at = env.ledger().timestamp() - 1;
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(&env), &None);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_fighter_name_empty() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut fight = sample_fight(&env);
        fight.fighter_a = String::from_str(&env, "");
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(&env), &None);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_min_bet_zero() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut config = sample_market_config(&env);
        config.min_bet_amount = 0;
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &sample_fight(&env), &config, &None);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_max_bet_less_than_min_bet() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut config = sample_market_config(&env);
        config.max_bet = config.min_bet_amount - 1;
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &sample_fight(&env), &config, &None);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_fee_bps_exceeds_1000() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let mut config = sample_market_config(&env);
        config.fee_bps = 1001;
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &sample_fight(&env), &config, &None);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_market_fails_when_wasm_hash_not_set() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let caller = Address::generate(&env);
        let result = client.try_create_market(
            &caller,
            &sample_fight(&env),
            &sample_market_config(&env),
            &None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_get_market_address_not_found() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let result = client.try_get_market_address(&0u64);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_market_ids_empty() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let ids = client.list_market_ids(&0u64, &10u32);
        assert_eq!(ids.len(), 0);
    }

    #[test]
    fn test_list_market_ids_pagination_capped_at_100() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let ids = client.list_market_ids(&0u64, &200u32);
        assert!(ids.len() <= 100);
    }

    #[test]
    fn test_list_market_ids_offset_beyond_end_returns_empty() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let ids = client.list_market_ids(&999u64, &10u32);
        assert_eq!(ids.len(), 0);
    }
}

// ============================================================
// ISSUE #250: MarketFactory::create_market scheduled_at validation
// ============================================================
#[cfg(test)]
mod scheduled_at_validation_tests {
    use crate::{MarketFactory, MarketFactoryClient, MIN_MARKET_DURATION};
    use boxmeout_shared::errors::ContractError;
    use boxmeout_shared::types::{FactoryConfig, FightDetails, MarketConfig};
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String};

    fn setup() -> (Env, MarketFactoryClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MarketFactory);
        let client = MarketFactoryClient::new(&env, &contract_id);
        (env, client)
    }

    fn default_config() -> FactoryConfig {
        FactoryConfig {
            default_min_bet: 1_000_000,
            default_max_bet: 100_000_000_000,
            default_fee_bps: 200,
            default_lock_before_secs: 3_600,
            default_resolution_window: 86_400,
        }
    }

    fn sample_market_config() -> MarketConfig {
        MarketConfig {
            min_bet_amount: 1_000_000,
            max_bet: 100_000_000_000,
            max_bet_share_bps: 2_000,
            fee_bps: 200,
            lock_before_secs: 3_600,
            resolution_window: 86_400,
            tier: 0,
            dispute_cooldown_ledgers: 0,
        }
    }

    fn init_factory(env: &Env, client: &MarketFactoryClient) {
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let oracle = Address::generate(env);
        let oracle_raw_key: BytesN<32> = BytesN::from_array(env, &[1u8; 32]);
        client.initialize(
            &admin,
            &treasury,
            &oracle,
            &oracle_raw_key,
            &default_config(),
        );
    }

    fn fight_with_timestamp(env: &Env, scheduled_at: u64) -> FightDetails {
        FightDetails {
            match_id: String::from_str(env, "FIGHT-001"),
            fighter_a: String::from_str(env, "Ali"),
            fighter_b: String::from_str(env, "Frazier"),
            weight_class: String::from_str(env, "Heavyweight"),
            scheduled_at,
            venue: String::from_str(env, "Arena"),
            title_fight: true,
        }
    }

    // ── InvalidTimeRange boundary (fight is in the past / present) ──────────

    /// Timestamp exactly equal to current ledger timestamp → rejected with InvalidTimeRange
    #[test]
    fn test_equal_timestamp_rejected() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let current_ts = env.ledger().timestamp();
        let fight = fight_with_timestamp(&env, current_ts);
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(), &None);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(
            err,
            ContractError::InvalidTimeRange,
            "Timestamp equal to current ledger time must be rejected with InvalidTimeRange"
        );
    }

    /// Past timestamp → rejected with InvalidTimeRange
    #[test]
    fn test_past_timestamp_rejected() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let past_ts = env.ledger().timestamp().saturating_sub(1);
        let fight = fight_with_timestamp(&env, past_ts);
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(), &None);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(
            err,
            ContractError::InvalidTimeRange,
            "Past timestamp must be rejected with InvalidTimeRange"
        );
    }

    /// Boundary: 1 second before current → rejected with InvalidTimeRange
    #[test]
    fn test_one_second_before_rejected() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let ts = env.ledger().timestamp().saturating_sub(1);
        let fight = fight_with_timestamp(&env, ts);
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(), &None);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(
            err,
            ContractError::InvalidTimeRange,
            "One second before current time must be rejected with InvalidTimeRange"
        );
    }

    /// Zero timestamp → rejected with InvalidTimeRange
    #[test]
    fn test_zero_timestamp_rejected() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let fight = fight_with_timestamp(&env, 0);
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(), &None);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(
            err,
            ContractError::InvalidTimeRange,
            "Zero timestamp must be rejected with InvalidTimeRange"
        );
    }

    // ── InvalidFightDate boundary (fight is in the future but within MIN_MARKET_DURATION) ──

    /// 1 second in the future is within MIN_MARKET_DURATION → rejected with InvalidFightDate
    #[test]
    fn test_one_second_after_rejected_with_invalid_fight_date() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let ts = env.ledger().timestamp() + 1;
        let fight = fight_with_timestamp(&env, ts);
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(), &None);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(
            err,
            ContractError::InvalidFightDate,
            "Timestamp 1 second ahead must be rejected with InvalidFightDate (within MIN_MARKET_DURATION)"
        );
    }

    /// Exactly at MIN_MARKET_DURATION boundary (== not >) → still rejected with InvalidFightDate
    #[test]
    fn test_exactly_at_min_duration_boundary_rejected() {
        let (env, client) = setup();
        init_factory(&env, &client);

        // scheduled_at == now + MIN_MARKET_DURATION fails the strict > check
        let ts = env.ledger().timestamp() + MIN_MARKET_DURATION;
        let fight = fight_with_timestamp(&env, ts);
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(), &None);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(
            err,
            ContractError::InvalidFightDate,
            "scheduled_at == now + MIN_MARKET_DURATION must be rejected (boundary is exclusive)"
        );
    }

    /// One second beyond MIN_MARKET_DURATION → passes validation, fails only on WasmHashNotSet
    #[test]
    fn test_one_second_beyond_min_duration_passes_validation() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let ts = env.ledger().timestamp() + MIN_MARKET_DURATION + 1;
        let fight = fight_with_timestamp(&env, ts);
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(), &None);
        // Validation passes; only WasmHashNotSet blocks creation at this point
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(
            err,
            ContractError::WasmHashNotSet,
            "scheduled_at one second beyond MIN_MARKET_DURATION must only fail on WasmHashNotSet"
        );
    }

    // ── Well-within-future range (sanity checks) ────────────────────────────

    /// Future timestamp (24 h) → passes validation, fails only on WasmHashNotSet
    #[test]
    fn test_future_timestamp_passes_validation() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let future_ts = env.ledger().timestamp() + 86_400; // 24 hours
        let fight = fight_with_timestamp(&env, future_ts);
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(), &None);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(
            err,
            ContractError::WasmHashNotSet,
            "Future timestamp (24 h) must pass date validation and fail only on WasmHashNotSet"
        );
    }

    /// Large future timestamp (1 year) → passes validation, fails only on WasmHashNotSet
    #[test]
    fn test_large_future_timestamp_passes_validation() {
        let (env, client) = setup();
        init_factory(&env, &client);

        let future_ts = env.ledger().timestamp() + 365 * 86_400;
        let fight = fight_with_timestamp(&env, future_ts);
        let caller = Address::generate(&env);
        let result = client.try_create_market(&caller, &fight, &sample_market_config(), &None);
        assert!(result.is_err());
        let err = result.unwrap_err().unwrap();
        assert_eq!(
            err,
            ContractError::WasmHashNotSet,
            "Large future timestamp (1 year) must pass date validation and fail only on WasmHashNotSet"
        );
    }
}

// ============================================================
// ISSUE #258: OPEN_MARKETS lifecycle cleanup tests
// ============================================================
#[cfg(test)]
mod open_markets_cleanup_tests {
    use crate::{MarketFactory, MarketFactoryClient};
    use boxmeout_shared::types::FactoryConfig;
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

    fn setup() -> (Env, MarketFactoryClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MarketFactory);
        let client = MarketFactoryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let oracle = Address::generate(&env);
        let oracle_raw_key: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);
        client.initialize(
            &admin,
            &treasury,
            &oracle,
            &oracle_raw_key,
            &FactoryConfig {
                default_min_bet: 1_000_000,
                default_max_bet: 100_000_000_000,
                default_fee_bps: 200,
                default_lock_before_secs: 3_600,
                default_resolution_window: 86_400,
            },
        );
        (env, client, admin)
    }

    /// cleanup_terminal_market rejects when market_id doesn't exist
    #[test]
    fn test_cleanup_rejects_nonexistent_market() {
        let (env, client, _admin) = setup();
        let market_addr = Address::generate(&env);
        let result = client.try_cleanup_terminal_market(&market_addr, &999u64);
        assert!(result.is_err());
    }

    /// cleanup_terminal_market rejects when address doesn't match registered market
    #[test]
    fn test_cleanup_rejects_wrong_address() {
        let (env, client, _admin) = setup();
        let wrong_addr = Address::generate(&env);
        let result = client.try_cleanup_terminal_market(&wrong_addr, &0u64);
        assert!(result.is_err());
    }

    /// get_open_market_ids returns empty initially
    #[test]
    fn test_get_open_markets_empty_initially() {
        let (_env, client, _admin) = setup();
        let open = client.get_open_market_ids();
        assert_eq!(open.len(), 0);
    }

    /// get_all_market_ids returns empty initially
    #[test]
    fn test_get_all_market_ids_empty_initially() {
        let (_env, client, _admin) = setup();
        let all = client.get_all_market_ids();
        assert_eq!(all.len(), 0);
    }
}

// ============================================================
// ISSUE #26: Two-step admin transfer tests
// ============================================================
#[cfg(test)]
mod admin_transfer_tests {
    use crate::{MarketFactory, MarketFactoryClient};
    use boxmeout_shared::types::FactoryConfig;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Address, BytesN, Env};

    fn setup() -> (Env, MarketFactoryClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MarketFactory);
        let client = MarketFactoryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let oracle = Address::generate(&env);
        let oracle_raw_key: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);
        client.initialize(
            &admin,
            &treasury,
            &oracle,
            &oracle_raw_key,
            &FactoryConfig {
                default_min_bet: 1_000_000,
                default_max_bet: 100_000_000_000,
                default_fee_bps: 200,
                default_lock_before_secs: 3_600,
                default_resolution_window: 86_400,
            },
        );
        (env, client, admin)
    }

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(soroban_sdk::testutils::LedgerInfo {
            timestamp: ts,
            protocol_version: 22,
            sequence_number: 100,
            network_id: Default::default(),
            base_reserve: 1,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_311_520,
        });
    }

    /// Happy path: propose → wait timelock → accept promotes the new admin and clears PENDING_ADMIN.
    #[test]
    fn test_propose_then_accept_transfers_admin() {
        let (env, client, admin) = setup();
        let new_admin = Address::generate(&env);

        // Step 1: current admin proposes
        client.propose_admin(&admin, &new_admin);

        // Early accept before timelock fails
        let early_res = client.try_accept_admin(&new_admin);
        assert_eq!(
            early_res.unwrap_err(),
            Ok(boxmeout_shared::errors::ContractError::AdminTimelockActive)
        );

        // Advance ledger past 24h timelock
        set_time(&env, 86_401);

        // Step 2: nominee accepts
        client.accept_admin(&new_admin);

        // New admin can now call an admin-only function; old admin cannot
        let non_admin = Address::generate(&env);
        let result_old = client.try_pause_factory(&admin);
        let result_new = client.try_pause_factory(&new_admin);
        // old admin is rejected, new admin succeeds
        assert!(
            result_old.is_err(),
            "Old admin must be rejected after transfer"
        );
        assert!(
            result_new.is_ok(),
            "New admin must be accepted after transfer"
        );
    }

    /// Tests that early acceptance before 24h time-lock is rejected.
    #[test]
    fn test_early_acceptance_rejected_by_timelock() {
        let (env, client, admin) = setup();
        let new_admin = Address::generate(&env);

        client.propose_admin(&admin, &new_admin);

        // Immediately try to accept — must be rejected
        let early = client.try_accept_admin(&new_admin);
        assert_eq!(
            early.unwrap_err(),
            Ok(boxmeout_shared::errors::ContractError::AdminTimelockActive)
        );

        // Advance to 86,399 seconds (1 second before 24h)
        set_time(&env, 86_399);
        let still_early = client.try_accept_admin(&new_admin);
        assert_eq!(
            still_early.unwrap_err(),
            Ok(boxmeout_shared::errors::ContractError::AdminTimelockActive)
        );

        // Advance to exactly 86,400 seconds — must succeed
        set_time(&env, 86_400);
        let ok = client.try_accept_admin(&new_admin);
        assert!(ok.is_ok());
        assert_eq!(client.get_admin(), new_admin);
    }

    /// Tests deploy-time configurable timelock
    #[test]
    fn test_configurable_admin_timelock() {
        let (env, client, admin) = setup();
        let new_admin = Address::generate(&env);

        // Configure timelock to 3600 seconds (1 hour)
        client.set_admin_timelock(&admin, &3600);
        assert_eq!(client.get_admin_timelock(), 3600);

        client.propose_admin(&admin, &new_admin);

        set_time(&env, 3599);
        let early = client.try_accept_admin(&new_admin);
        assert_eq!(
            early.unwrap_err(),
            Ok(boxmeout_shared::errors::ContractError::AdminTimelockActive)
        );

        set_time(&env, 3600);
        assert!(client.try_accept_admin(&new_admin).is_ok());
    }

    /// Wrong caller: a third party cannot accept a pending proposal.
    #[test]
    fn test_wrong_caller_cannot_accept_admin() {
        let (env, client, admin) = setup();
        let new_admin = Address::generate(&env);
        let impostor = Address::generate(&env);

        client.propose_admin(&admin, &new_admin);
        set_time(&env, 86_401);

        let result = client.try_accept_admin(&impostor);
        assert!(
            result.is_err(),
            "Impostor must not be able to accept pending proposal"
        );
    }

    /// Accept with no pending proposal returns NotAdmin.
    #[test]
    fn test_accept_with_no_pending_proposal_fails() {
        let (env, client, _admin) = setup();
        let anyone = Address::generate(&env);

        let result = client.try_accept_admin(&anyone);
        assert!(
            result.is_err(),
            "accept_admin with no pending proposal must fail"
        );
    }

    /// Non-admin cannot propose.
    #[test]
    fn test_non_admin_cannot_propose() {
        let (env, client, _admin) = setup();
        let non_admin = Address::generate(&env);
        let target = Address::generate(&env);

        let result = client.try_propose_admin(&non_admin, &target);
        assert!(
            result.is_err(),
            "Non-admin must not be able to propose a new admin"
        );
    }

    /// Re-propose: calling propose_admin again overwrites the previous pending admin.
    #[test]
    fn test_re_propose_overwrites_previous_pending_admin() {
        let (env, client, admin) = setup();
        let first_nominee = Address::generate(&env);
        let second_nominee = Address::generate(&env);

        // First proposal
        client.propose_admin(&admin, &first_nominee);

        // Re-propose with a different address before first nominee accepts
        client.propose_admin(&admin, &second_nominee);

        set_time(&env, 86_401);

        // First nominee can no longer accept — the slot was overwritten
        let result_first = client.try_accept_admin(&first_nominee);
        assert!(
            result_first.is_err(),
            "Overwritten nominee must not be able to accept"
        );

        // Second nominee can accept
        let result_second = client.try_accept_admin(&second_nominee);
        assert!(
            result_second.is_ok(),
            "Current nominee must be able to accept after re-propose"
        );
    }

    /// After a completed transfer, PENDING_ADMIN is cleared —
    /// the old nominee cannot accept again (no double-accept).
    #[test]
    fn test_pending_admin_cleared_after_accept() {
        let (env, client, admin) = setup();
        let new_admin = Address::generate(&env);

        client.propose_admin(&admin, &new_admin);
        set_time(&env, 86_401);
        client.accept_admin(&new_admin);

        // A second accept call must fail because PENDING_ADMIN was cleared
        let result = client.try_accept_admin(&new_admin);
        assert!(
            result.is_err(),
            "Second accept must fail after PENDING_ADMIN is cleared"
        );
    }
}

// =====================================================
// TASK 12: Soroban Contract Integrity & Safety Verification Tests
// Covers: storage TTL extensions across persistent maps in Factory,
//         auth checks and error handling audit,
//         market deployment validation and oracle management.
// ============================================================
#[cfg(test)]
mod task12_factory_market_integrity_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        Address, BytesN, Env,
    };
    use boxmeout_shared::{
        errors::ContractError,
        types::{FactoryConfig, FightDetails, MarketConfig},
    };
    use crate::{MarketFactory, MarketFactoryClient, ADMIN, MARKET_COUNT, ORACLE_WHITELIST};

    fn setup_factory(env: &Env) -> (MarketFactoryClient<'static>, Address, Address, Address) {
        env.mock_all_auths();
        env.ledger().set(LedgerInfo {
            timestamp: 50_000,
            protocol_version: 22,
            sequence_number: 500,
            network_id: Default::default(),
            base_reserve: 1,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_311_520,
        });

        let contract_id = env.register_contract(None, MarketFactory);
        let client = MarketFactoryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let oracle = Address::generate(env);
        let oracle_raw_key: BytesN<32> = BytesN::from_array(env, &[7u8; 32]);

        client.initialize(
            &admin,
            &treasury,
            &oracle,
            &oracle_raw_key,
            &FactoryConfig {
                default_min_bet: 1_000_000,
                default_max_bet: 100_000_000_000,
                default_fee_bps: 200,
                default_lock_before_secs: 3_600,
                default_resolution_window: 86_400,
            },
        );

        env.as_contract(&contract_id, || {
            env.storage().instance().extend_ttl(100_000, 100_000);
            env.storage().persistent().extend_ttl(&ADMIN, 100_000, 100_000);
            env.storage().persistent().extend_ttl(&MARKET_COUNT, 100_000, 100_000);
            env.storage().persistent().extend_ttl(&ORACLE_WHITELIST, 100_000, 100_000);
        });

        (client, admin, treasury, oracle)
    }

    // ── 1. Storage TTL Extensions Across Persistent Maps ─────────
    #[test]
    fn test_task12_persistent_map_ttl_survival() {
        let env = Env::default();
        let (client, admin, _treasury, oracle) = setup_factory(&env);

        // Advance ledger 50,000 sequences
        env.ledger().set(LedgerInfo {
            timestamp: 50_000 + 86_400 * 14,
            protocol_version: 22,
            sequence_number: 50_500,
            network_id: Default::default(),
            base_reserve: 1,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_311_520,
        });

        // Verify storage maps persist and remain readable
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_market_count(), 0u64);
        let oracles = client.get_oracles();
        assert_eq!(oracles.len(), 1);
        assert_eq!(oracles.get(0).unwrap(), oracle);
    }

    // ── 2. Comprehensive Auth & Error Handling Audit ─────────────
    #[test]
    fn test_task12_auth_checks_and_error_handling() {
        let env = Env::default();
        let (client, admin, _treasury, _oracle) = setup_factory(&env);
        let non_admin = Address::generate(&env);
        let wasm_hash = BytesN::from_array(&env, &[1u8; 32]);

        // Non-admin cannot update wasm hash
        let err_wasm = client.try_update_market_wasm(&non_admin, &wasm_hash);
        assert_eq!(err_wasm.unwrap_err(), Ok(ContractError::NotAdmin));

        // Non-admin cannot pause / unpause factory
        let err_pause = client.try_pause_factory(&non_admin);
        assert_eq!(err_pause.unwrap_err(), Ok(ContractError::NotAdmin));

        let err_unpause = client.try_unpause_factory(&non_admin);
        assert_eq!(err_unpause.unwrap_err(), Ok(ContractError::NotAdmin));

        // Non-admin cannot propose admin
        let nominee = Address::generate(&env);
        let err_prop = client.try_propose_admin(&non_admin, &nominee);
        assert_eq!(err_prop.unwrap_err(), Ok(ContractError::NotAdmin));

        // Non-admin cannot add or remove oracle
        let new_oracle = Address::generate(&env);
        let raw_key = BytesN::from_array(&env, &[2u8; 32]);
        let err_add_oracle = client.try_add_oracle(&non_admin, &new_oracle, &raw_key);
        assert_eq!(err_add_oracle.unwrap_err(), Ok(ContractError::NotAdmin));

        let err_rem_oracle = client.try_remove_oracle(&non_admin, &new_oracle);
        assert_eq!(err_rem_oracle.unwrap_err(), Ok(ContractError::NotAdmin));
    }

    // ── 3. Market Creation Parameter Validation Audit ────────────
    #[test]
    fn test_task12_create_market_parameter_validations() {
        let env = Env::default();
        let (client, admin, _treasury, _oracle) = setup_factory(&env);
        let caller = Address::generate(&env);

        let valid_fight = FightDetails {
            match_id: soroban_sdk::String::from_str(&env, "VALID-MATCH"),
            fighter_a: soroban_sdk::String::from_str(&env, "Alice"),
            fighter_b: soroban_sdk::String::from_str(&env, "Bob"),
            weight_class: soroban_sdk::String::from_str(&env, "Middleweight"),
            scheduled_at: 100_000,
            venue: soroban_sdk::String::from_str(&env, "MGM"),
            title_fight: true,
        };

        let valid_config = MarketConfig {
            min_bet_amount: 1_000_000,
            max_bet: 100_000_000_000,
            max_bet_share_bps: 2_000,
            fee_bps: 200,
            lock_before_secs: 3_600,
            resolution_window: 86_400,
            tier: 0,
            dispute_cooldown_ledgers: 0,
        };

        // 1. Fight scheduled in the past
        let mut past_fight = valid_fight.clone();
        past_fight.scheduled_at = 40_000; // current time is 50_000
        let err_past = client.try_create_market(&caller, &past_fight, &valid_config, &None);
        assert_eq!(err_past.unwrap_err(), Ok(ContractError::InvalidTimeRange));

        // 2. Empty fighter name
        let mut empty_fighter = valid_fight.clone();
        empty_fighter.fighter_a = soroban_sdk::String::from_str(&env, "");
        let err_empty = client.try_create_market(&caller, &empty_fighter, &valid_config, &None);
        assert_eq!(err_empty.unwrap_err(), Ok(ContractError::InvalidMarketParameters));

        // 3. Zero min bet amount
        let mut zero_min_bet = valid_config.clone();
        zero_min_bet.min_bet_amount = 0;
        let err_zero_min = client.try_create_market(&caller, &valid_fight, &zero_min_bet, &None);
        assert_eq!(err_zero_min.unwrap_err(), Ok(ContractError::BelowMinimum));

        // 4. Excessive fee_bps (> 1000)
        let err_fee = client.try_create_market(&caller, &valid_fight, &valid_config, &Some(1500));
        assert_eq!(err_fee.unwrap_err(), Ok(ContractError::InvalidMarketParameters));
    }

    // ── 4. Oracle Whitelist Lifecycle & Lookups ──────────────────
    #[test]
    fn test_task12_oracle_whitelist_lifecycle() {
        let env = Env::default();
        let (client, admin, _treasury, oracle1) = setup_factory(&env);
        let oracle2 = Address::generate(&env);
        let key2 = BytesN::from_array(&env, &[9u8; 32]);

        // Add second oracle
        client.add_oracle(&admin, &oracle2, &key2);
        assert_eq!(client.get_oracles().len(), 2);
        assert_eq!(client.get_oracle_key(&oracle2), Some(key2.clone()));

        // Adding duplicate oracle fails
        let err_dup = client.try_add_oracle(&admin, &oracle2, &key2);
        assert_eq!(err_dup.unwrap_err(), Ok(ContractError::OracleAlreadyWhitelisted));

        // Remove oracle2
        client.remove_oracle(&admin, &oracle2);
        assert_eq!(client.get_oracles().len(), 1);
        assert_eq!(client.get_oracle_key(&oracle2), None);
    }

    // ── 5. Duplicate Fighter Names Validation (Issue #639 / #13) ──
    #[test]
    fn test_duplicate_fighter_names_validation() {
        let env = Env::default();
        let (client, _admin, _treasury, _oracle) = setup_factory(&env);
        let caller = Address::generate(&env);

        let mut fight = FightDetails {
            match_id: soroban_sdk::String::from_str(&env, "DUPE-MATCH"),
            fighter_a: soroban_sdk::String::from_str(&env, "Ali"),
            fighter_b: soroban_sdk::String::from_str(&env, "Ali"),
            weight_class: soroban_sdk::String::from_str(&env, "Heavyweight"),
            scheduled_at: 100_000,
            venue: soroban_sdk::String::from_str(&env, "MGM"),
            title_fight: true,
        };

        let config = MarketConfig {
            min_bet_amount: 1_000_000,
            max_bet: 100_000_000_000,
            fee_bps: 200,
            lock_before_secs: 3_600,
            resolution_window: 86_400,
            tier: 0,
            dispute_cooldown_ledgers: 0,
        };

        // 1. Same exact name -> DuplicateFighterName
        let err_same = client.try_create_market(&caller, &fight, &config, &None);
        assert_eq!(err_same.unwrap_err(), Ok(ContractError::DuplicateFighterName));

        // 2. Same name, different case -> DuplicateFighterName
        fight.fighter_b = soroban_sdk::String::from_str(&env, "ALI");
        let err_case1 = client.try_create_market(&caller, &fight, &config, &None);
        assert_eq!(err_case1.unwrap_err(), Ok(ContractError::DuplicateFighterName));

        fight.fighter_a = soroban_sdk::String::from_str(&env, "Mike Tyson");
        fight.fighter_b = soroban_sdk::String::from_str(&env, "mike tyson");
        let err_case2 = client.try_create_market(&caller, &fight, &config, &None);
        assert_eq!(err_case2.unwrap_err(), Ok(ContractError::DuplicateFighterName));

        // 3. Different names -> passes duplicate check (fails on WasmHashNotSet because WASM is not loaded)
        fight.fighter_b = soroban_sdk::String::from_str(&env, "Evander Holyfield");
        let err_diff = client.try_create_market(&caller, &fight, &config, &None);
        assert_ne!(err_diff.unwrap_err(), Ok(ContractError::DuplicateFighterName));
    }

    // ── 6. Admin Pause Individual Market Controls (Issue #649 / #23) ──
    #[test]
    fn test_factory_market_pause_controls() {
        let env = Env::default();
        let (client, admin, _treasury, _oracle) = setup_factory(&env);
        let non_admin = Address::generate(&env);

        // Non-admin cannot pause market
        let err_pause_non_admin = client.try_pause_market(&non_admin, &1u64);
        assert_eq!(err_pause_non_admin.unwrap_err(), Ok(ContractError::NotAdmin));

        // Non-admin cannot unpause market
        let err_unpause_non_admin = client.try_unpause_market(&non_admin, &1u64);
        assert_eq!(err_unpause_non_admin.unwrap_err(), Ok(ContractError::NotAdmin));

        // Admin pausing nonexistent market returns MarketNotFound
        let err_not_found = client.try_pause_market(&admin, &999u64);
        assert_eq!(err_not_found.unwrap_err(), Ok(ContractError::MarketNotFound));

        // Admin unpausing nonexistent market returns MarketNotFound
        let err_unpause_not_found = client.try_unpause_market(&admin, &999u64);
        assert_eq!(err_unpause_not_found.unwrap_err(), Ok(ContractError::MarketNotFound));

        // Querying status of nonexistent market returns MarketNotFound
        let err_status = client.try_get_market_status(&999u64);
        assert_eq!(err_status.unwrap_err(), Ok(ContractError::MarketNotFound));

        // Refund expired on nonexistent market returns MarketNotFound
        let err_refund = client.try_refund_expired(&999u64);
        assert_eq!(err_refund.unwrap_err(), Ok(ContractError::MarketNotFound));
    }
}
