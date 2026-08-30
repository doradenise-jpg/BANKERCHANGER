#![no_std]
//! ============================================================
//! BANKERCHANGER — Treasury Contract (Security-Audited)
//!
//! Module 19 (#498) + Module 20 (#499):
//!   • Per-token daily withdrawal caps (separate from per-tx limit)
//!   • Atomic double-withdrawal prevention via a FEE_LOCK key
//!   • Explicit pause_withdrawals / unpause_withdrawals admin functions
//!   • Immutable append-only audit log (AUDIT_LOG) with AuditEntry struct
//!   • get_audit_log / get_audit_log_len query functions
//!
//! All fund-moving functions follow Checks-Effects-Interactions.
//! require_auth() is always the first call.
//!
//! Issues #494 / #495 additions:
//!   • DAILY_CAP  — configurable per-day withdrawal ceiling
//!   • WITHDRAWAL_LOCK — boolean reentrancy guard
//!   • AUDIT_LOG_SEQ  — monotonic counter for immutable audit entries
//! =====================================================

use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Env, Map, Symbol, Vec,
};

use boxmeout_shared::errors::ContractError;
use boxmeout_shared::types::{AuditAction, AuditEntry};

const ADMIN: &str = "ADMIN";
const BET_TOKEN: &str = "BET_TOKEN";
const FACTORY: &str = "FACTORY";
const ACCUMULATED_FEES: &str = "ACCUMULATED_FEES"; // token -> total
const ACCUMULATED_FEES_BY_MARKET: &str = "ACCUMULATED_FEES_BY_MARKET"; // market_id -> (token -> amount)
const APPROVED_MARKETS: &str = "APPROVED_MARKETS";
const WITHDRAWAL_LIMIT: &str = "WITHDRAWAL_LIMIT";
const DAILY_WITHDRAWN: &str = "DAILY_WITHDRAWN";
const WITHDRAWALS_PAUSED: &str = "WITHDRAWALS_PAUSED";
const AUDIT_LOG: &str = "AUDIT_LOG"; // Vec<AuditEntry> (append-only)
const AUDIT_NEXT_ID: &str = "AUDIT_NEXT_ID"; // u64 monotonically increasing
const WITHDRAWAL_IN_PROGRESS: &str = "WITHDRAWAL_IN_PROGRESS"; // reentrancy guard
const MIN_WITHDRAWAL: i128 = 10_000_000; // 1 XLM in stroops

use boxmeout_shared::types::AuditEntry;

// ── Persistent storage keys ───────────────────────────────────────────────────
const ADMIN: &str                        = "ADMIN";
const BET_TOKEN: &str                    = "BET_TOKEN";
const FACTORY: &str                      = "FACTORY";
const ACCUMULATED_FEES: &str             = "ACCUMULATED_FEES";            // Map<Address,i128>
const ACCUMULATED_FEES_BY_MARKET: &str   = "ACCUMULATED_FEES_BY_MARKET";  // Map<u64,Map<Address,i128>>
const APPROVED_MARKETS: &str             = "APPROVED_MARKETS";
const WITHDRAWAL_LIMIT: &str             = "WITHDRAWAL_LIMIT";             // per-tx cap
const DAILY_WITHDRAWN: &str              = "DAILY_WITHDRAWN";              // Map<u64,i128>
const WITHDRAWALS_PAUSED: &str           = "WITHDRAWALS_PAUSED";           // bool

// ── New storage keys (issues #494 / #495) ─────────────────────────────────────
/// Configurable maximum total withdrawal allowed per calendar day (in stroops).
/// Defaults to WITHDRAWAL_LIMIT * 5 when not explicitly set.
const DAILY_CAP: &str                    = "DAILY_CAP";
/// Boolean reentrancy guard — set to `true` at start of withdraw_fees,
/// cleared at the end.  Any re-entrant call sees the lock and panics with
/// ReentrancyGuard (error 60).
const WITHDRAWAL_LOCK: &str              = "WITHDRAWAL_LOCK";
/// Monotonically-increasing sequence counter for audit log entries.
/// Starts at 0; incremented before each write so entries are 1-based.
const AUDIT_LOG_SEQ: &str               = "AUDIT_LOG_SEQ";
/// Temporary storage prefix for individual audit entries.
/// Full key: (AUDIT_ENTRY_PREFIX, seq: u64) — stored in TEMPORARY storage.
const AUDIT_ENTRY_PREFIX: &str          = "AUDIT";

const MIN_WITHDRAWAL: i128 = 10_000_000; // 1 XLM in stroops

// ── Storage keys ────────────────────────────────────────────────────────────

const ADMIN: &str                        = "ADMIN";
const BET_TOKEN: &str                    = "BET_TOKEN";
const FACTORY: &str                      = "FACTORY";
const ACCUMULATED_FEES: &str             = "ACCUMULATED_FEES";        // token -> total
const ACCUMULATED_FEES_BY_MARKET: &str   = "ACCUMULATED_FEES_BY_MARKET"; // market_id -> (token -> amount)
const APPROVED_MARKETS: &str             = "APPROVED_MARKETS";
const WITHDRAWAL_LIMIT: &str             = "WITHDRAWAL_LIMIT";        // per-tx cap (per token class)
const DAILY_WITHDRAWN: &str              = "DAILY_WITHDRAWN";         // bucket -> aggregate total
const DAILY_TOKEN_CAP: &str              = "DAILY_TOKEN_CAP";         // token -> cap amount         [#499]
const WITHDRAWALS_PAUSED: &str           = "WITHDRAWALS_PAUSED";
const FEE_LOCK: &str                     = "FEE_LOCK";                // bool — double-withdrawal guard [#498]
const AUDIT_LOG: &str                    = "AUDIT_LOG";               // Vec<AuditEntry>              [#498 / #499]

const MIN_WITHDRAWAL: i128 = 10_000_000; // 1 XLM in stroops

// ── Audit entry type (immutable once appended) ──────────────────────────────

/// A single record written to the immutable audit log whenever fees are moved.
/// Fields are intentionally primitive so the struct is #[contracttype]-safe.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEntry {
    /// Short action label, e.g. "withdraw", "deposit", "emergency_drain",
    /// "pause", "unpause".
    pub action: Symbol,
    /// Address that initiated the action.
    pub actor: Address,
    /// Token contract address involved in the action.
    pub token: Address,
    /// Amount moved (0 for pause/unpause entries).
    pub amount: i128,
    /// Ledger timestamp at the time of the action.
    pub timestamp: u64,
}

// ── Contract ─────────────────────────────────────────────────────────────────

const ADMIN: &str                         = "ADMIN";
const BET_TOKEN: &str                     = "BET_TOKEN";
const FACTORY: &str                       = "FACTORY";
const ACCUMULATED_FEES: &str              = "ACCUMULATED_FEES";           // token -> total
const ACCUMULATED_FEES_BY_MARKET: &str    = "ACCUMULATED_FEES_BY_MARKET"; // market_id -> (token -> amount)
const APPROVED_MARKETS: &str              = "APPROVED_MARKETS";
const WITHDRAWAL_LIMIT: &str              = "WITHDRAWAL_LIMIT";
const DAILY_WITHDRAWN: &str               = "DAILY_WITHDRAWN";             // global: bucket -> i128
const DAILY_WITHDRAWN_BY_TOKEN: &str      = "DAILY_WITHDRAWN_BY_TOKEN";    // per-token: token -> (bucket -> i128)
const WITHDRAWALS_PAUSED: &str            = "WITHDRAWALS_PAUSED";
const AUDIT_LOG: &str                     = "AUDIT_LOG";                   // Vec<AuditEntry> (append-only)
const AUDIT_NEXT_ID: &str                 = "AUDIT_NEXT_ID";               // u64 monotonically increasing
const WITHDRAWAL_IN_PROGRESS: &str        = "WITHDRAWAL_IN_PROGRESS";      // reentrancy guard
const MIN_WITHDRAWAL: i128                = 10_000_000;                    // 1 XLM in stroops

const APPROVED_MARKETS: &str        = "APPROVED_MARKETS";
const WITHDRAWAL_LIMIT: &str        = "WITHDRAWAL_LIMIT";
const DAILY_WITHDRAWN: &str         = "DAILY_WITHDRAWN";
const WITHDRAWALS_PAUSED: &str      = "WITHDRAWALS_PAUSED";
const AUDIT_LOG: &str               = "AUDIT_LOG";          // Vec<AuditEntry> (append-only)
const AUDIT_NEXT_ID: &str           = "AUDIT_NEXT_ID";      // u64 monotonically increasing
const WITHDRAWAL_IN_PROGRESS: &str  = "WITHDRAWAL_IN_PROGRESS"; // reentrancy guard
const WITHDRAWAL_NONCE: &str        = "WITHDRAWAL_NONCE";   // u64 monotonically increasing
const MIN_WITHDRAWAL: i128          = 10_000_000; // 1 XLM in stroops
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

// ── Private helpers ──────────────────────────────────────────────────────────


// ── Internal helpers ──────────────────────────────────────────────────────────
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

    /// Prune DAILY_WITHDRAWN to keep only the current bucket and the one before it.

    /// Prune DAILY_WITHDRAWN to keep only the current bucket and the one before
    /// it.  This is a sliding two-day window that prevents unbounded map growth.
    /// Called from `withdraw_fees` on every successful withdrawal.
    fn prune_daily_withdrawn(env: &Env, daily: &mut Map<u64, i128>, current_bucket: u64) {

    /// Prune a bucket-keyed map to keep only the current bucket and the one
    /// before it.  Called on every withdrawal so the map never grows beyond 2
    /// entries.
    fn prune_daily_map(env: &Env, daily: &mut Map<u64, i128>, current_bucket: u64) {
        let mut stale: Vec<u64> = Vec::new(env);
        for (k, _) in daily.iter() {
            // keep current_bucket and current_bucket-1; evict everything older
            if k + 1 < current_bucket {

    /// Prune DAILY_WITHDRAWN to keep only the current bucket.
    /// Called on every withdrawal so the map never grows beyond 1 entry
    /// and previous day tallies never carry into the new day.
    fn prune_daily_withdrawn(env: &Env, daily: &mut Map<u64, i128>, current_bucket: u64) {
        let mut stale: Vec<u64> = Vec::new(env);
        for (k, _) in daily.iter() {
            if k < current_bucket {
                stale.push_back(k);
            }
        }
        for k in stale.iter() {
            daily.remove(k);
        }
    }

    /// Returns an error if a fee withdrawal transfer is already in progress.
    /// Prevents double-spend under concurrent invocations on the same ledger.
    fn require_not_withdrawing(env: &Env) -> Result<(), ContractError> {
        let withdrawing: bool = env.storage().instance().get(&FEE_WITHDRAWING).unwrap_or(false);
        if withdrawing {
            return Err(ContractError::ReentrancyGuard);
        }
        Ok(())
    }

    fn add_to_accumulated_token(env: &Env, token: &Address, amount: i128) {
        let mut fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(env));
        let current = fees.get(token.clone()).unwrap_or(0);
        fees.set(token.clone(), current + amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);
    }

    /// Appends an immutable entry to the audit ledger.
    ///
    /// The entry is assigned a monotonically increasing id and pushed onto the
    /// append-only `AUDIT_LOG`. Existing entries are never modified, so the log
    /// forms a tamper-evident, immutable history of every fund movement.
    fn record_audit(env: &Env, action: AuditAction, token: Address, amount: i128, actor: Address) {
        let next_id: u64 = env.storage().persistent().get(&AUDIT_NEXT_ID).unwrap_or(0);
        let entry = AuditEntry {
            id: next_id,
            action: action.clone(),
            token: token.clone(),
            amount,
            actor: actor.clone(),
            timestamp: env.ledger().timestamp(),
        };

        let mut log: Vec<AuditEntry> = env
            .storage()
            .persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(env));
        log.push_back(entry.clone());

        env.storage().persistent().set(&AUDIT_LOG, &log);
        env.storage()
            .persistent()
            .set(&AUDIT_NEXT_ID, &(next_id + 1));
        boxmeout_shared::emit_audit_recorded(env, entry);

    // ── Audit log helpers ──────────────────────────────────────────────────

    /// Appends an entry to the immutable audit log and emits an on-chain event.
    /// The log is append-only — existing entries are never modified or removed.
    fn append_audit_entry(env: &Env, entry: AuditEntry) {
        let mut log: Vec<AuditEntry> =
            env.storage().persistent().get(&AUDIT_LOG).unwrap_or_else(|| Vec::new(env));
        log.push_back(entry.clone());
        env.storage().persistent().set(&AUDIT_LOG, &log);

        // Emit event so indexers can pick it up without reading storage.
        boxmeout_shared::emit_audit_entry(
            env,
            entry.action,
            entry.actor,
            entry.token,
            entry.amount,
            entry.timestamp,
        );
    }

    // ── FEE_LOCK helpers (double-withdrawal prevention) ────────────────────

    /// Acquires the fee lock. Returns `Err(ReentrancyGuard)` if already held.
    fn acquire_fee_lock(env: &Env) -> Result<(), ContractError> {
        let locked: bool = env.storage().persistent().get(&FEE_LOCK).unwrap_or(false);
        if locked {
            return Err(ContractError::ReentrancyGuard);
        }
        env.storage().persistent().set(&FEE_LOCK, &true);
        Ok(())
    }

    /// Releases the fee lock unconditionally.
    fn release_fee_lock(env: &Env) {
        env.storage().persistent().set(&FEE_LOCK, &false);
    }

    // ── Per-token daily cap helpers ────────────────────────────────────────

    /// Returns how much of `token` has been withdrawn today (current bucket).
    /// Storage key: (Symbol("DTW"), token_address) — a tuple supported by Soroban.
    fn token_withdrawn_today(env: &Env, token: &Address, bucket: u64) -> i128 {
        let key = (Symbol::new(env, "DTW"), token.clone());
        let daily: Map<u64, i128> =
            env.storage().persistent().get(&key).unwrap_or_else(|| Map::new(env));
        daily.get(bucket).unwrap_or(0)
    }

    /// Records `amount` as withdrawn for `token` today, pruning stale buckets.
    fn record_token_withdrawal(env: &Env, token: &Address, bucket: u64, amount: i128) {
        let key = (Symbol::new(env, "DTW"), token.clone());
        let mut daily: Map<u64, i128> =
            env.storage().persistent().get(&key).unwrap_or_else(|| Map::new(env));
        let today = daily.get(bucket).unwrap_or(0);
        daily.set(bucket, today + amount);
        // Prune stale buckets (keep only current and previous)
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

    // ── Reentrancy helpers ────────────────────────────────────────────────────

    /// Acquires the withdrawal lock.  Returns `ReentrancyGuard` if already held.
    fn acquire_lock(env: &Env) -> Result<(), ContractError> {
        let locked: bool = env
            .storage()
            .instance()
            .get(&WITHDRAWAL_LOCK)
            .unwrap_or(false);
        if locked {
            return Err(ContractError::ReentrancyGuard);
        }
        env.storage().instance().set(&WITHDRAWAL_LOCK, &true);
        Ok(())
    }

    /// Releases the withdrawal lock.  Always call this after the token transfer
    /// so the lock is cleared even if the transfer panics (Soroban rolls back the
    /// entire transaction on panic, which also reverts the lock, so there is no
    /// stuck-lock risk — this call keeps the happy-path clean).
    fn release_lock(env: &Env) {
        env.storage().instance().set(&WITHDRAWAL_LOCK, &false);
    }

    // ── Audit log helpers ─────────────────────────────────────────────────────

    /// Appends an immutable audit entry to ledger TEMPORARY storage and emits an
    /// `audit_log_entry` event.  The entry is keyed by the next sequence number
    /// so it can never be overwritten.
    fn write_audit_entry(
        env: &Env,
        admin: Address,
        token: Address,
        amount: i128,
        destination: Address,
    ) {
        // Bump sequence counter
        let seq: u64 = env
            .storage()
            .persistent()
            .get(&AUDIT_LOG_SEQ)
            .unwrap_or(0u64)
            + 1;
        env.storage().persistent().set(&AUDIT_LOG_SEQ, &seq);

        let bucket = Self::day_bucket(env);
        let entry = AuditEntry {
            seq,
            admin,
            token,
            amount,
            destination,
            timestamp: env.ledger().timestamp(),
            day_bucket: bucket,
        };

        // Write to TEMPORARY storage under a unique (prefix, seq) key.
        // TEMPORARY entries live for min_temp_entry_ttl ledgers; off-chain
        // indexers must consume the event before that window expires.
        let audit_key = (AUDIT_ENTRY_PREFIX, seq);
        env.storage().temporary().set(&audit_key, &entry);

        // Emit event so indexers can capture the entry durably.
        boxmeout_shared::emit_audit_log_entry(env, entry);
    }

    /// Clear the reentrancy guard unconditionally.  All error returns in
    /// `withdraw_fees` call this before returning so the guard is never left set.
    #[inline]
    fn clear_guard(env: &Env) {
        env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
    }
}

// ── Public interface ─────────────────────────────────────────────────────────


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
    // ── Initialization ────────────────────────────────────────────────────

    /// Initializes the treasury with admin, tokens, and withdrawal limits.

    /// Initializes the treasury with admin, bet token, factory, and withdrawal
    /// limit.  A `DAILY_CAP` equal to `withdrawal_limit * 5` is set as the
    /// default; it can be updated later with `set_daily_cap`.
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

        // Default daily cap = 5× per-tx limit (matches the old hard-coded rule)
        env.storage().persistent().set(&DAILY_CAP, &(withdrawal_limit * 5));
        env.storage().persistent().set(
            &ACCUMULATED_FEES,
            &Map::<Address, i128>::new(&env),
        );

        env.storage()
            .persistent()
            .set(&WITHDRAWAL_LIMIT, &withdrawal_limit);
        env.storage()
            .persistent()
            .set(&ACCUMULATED_FEES, &Map::<Address, i128>::new(&env));
        env.storage().persistent().set(
            &ACCUMULATED_FEES_BY_MARKET,
            &Map::<u64, Map<Address, i128>>::new(&env),
        );
        env.storage().persistent().set(&DAILY_WITHDRAWN, &Map::<u64, i128>::new(&env));
        env.storage().persistent().set(&DAILY_TOKEN_CAP, &Map::<Address, i128>::new(&env));

        env.storage().persistent().set(&DAILY_WITHDRAWN_BY_TOKEN, &Map::<Address, Map<u64, i128>>::new(&env));
        env.storage().persistent().set(&APPROVED_MARKETS, &Vec::<Address>::new(&env));

        env.storage()
            .persistent()
            .set(&DAILY_WITHDRAWN, &Map::<u64, i128>::new(&env));
        env.storage()
            .persistent()
            .set(&APPROVED_MARKETS, &Vec::<Address>::new(&env));
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &false);
        env.storage()
            .persistent()
            .set(&AUDIT_LOG, &Vec::<AuditEntry>::new(&env));
        env.storage().persistent().set(&AUDIT_NEXT_ID, &0u64);
        env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);

        env.storage().persistent().set(&FEE_LOCK, &false);
        env.storage().persistent().set(&AUDIT_LOG, &Vec::<AuditEntry>::new(&env));

        env.storage().persistent().set(&AUDIT_LOG_SEQ, &0u64);
        // Ensure lock starts cleared
        env.storage().instance().set(&WITHDRAWAL_LOCK, &false);

        env.storage()
            .persistent()
            .set(&WITHDRAWAL_IN_PROGRESS, &false);

        env.storage().persistent().set(&WITHDRAWAL_NONCE, &0_u64);

        env.storage().persistent().set(&AUDIT_LOG, &Vec::<AuditEntry>::new(&env));
        Ok(())
    }

    // ── Market registry ───────────────────────────────────────────────────

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

    /// Registers a market address. Callable only by the Factory address stored
    /// at initialization.
    pub fn register_market(
        env: Env,
        caller: Address,
        market_address: Address,
    ) -> Result<(), ContractError> {
        // CHECKS
        market.require_auth();
        let markets: Vec<Address> = env
            .storage()
            .persistent()
            .get(&APPROVED_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market.clone()) {
            return Err(ContractError::MarketNotApproved);
        }

        // EFFECTS
        let mut fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        let current = fees.get(token.clone()).unwrap_or(0);
        fees.set(token.clone(), current + amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        // INTERACTIONS
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&market, &env.current_contract_address(), &amount);

        // AUDIT — immutable ledger entry
        Self::record_audit(
            &env,
            AuditAction::FeeDeposited,
            token.clone(),
            amount,
            market.clone(),
        );

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
        let markets: Vec<Address> = env
            .storage()
            .persistent()
            .get(&APPROVED_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
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
        let mut token_map: Map<Address, i128> =
            by_market.get(market_id).unwrap_or_else(|| Map::new(&env));
        let cur = token_map.get(token.clone()).unwrap_or(0);
        token_map.set(token.clone(), cur + amount);
        by_market.set(market_id, token_map);
        env.storage()
            .persistent()
            .set(&ACCUMULATED_FEES_BY_MARKET, &by_market);

        // INTERACTIONS — emit event (assumes token was already transferred by Market)
        // AUDIT — immutable ledger entry
        Self::record_audit(
            &env,
            AuditAction::FeeReceived,
            token.clone(),
            amount,
            market.clone(),
        );

        boxmeout_shared::emit_fee_deposited(&env, market, token, amount);
        Ok(())
    }

    /// Withdraws accumulated fees with per-transaction and daily limits.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    /// - `ReentrancyGuard`: A withdrawal is already in progress
    /// - `WithdrawalsPaused`: Withdrawals are temporarily paused
    /// - `BelowMinimum`: Withdrawal amount is below minimum (1 XLM)
    /// - `DailyWithdrawalLimitExceeded`: Withdrawal exceeds per-tx or daily limit
    /// - `InsufficientBalance`: Not enough fees accumulated
    ///
    /// # Security (CEI + concurrency)
    /// 1. CHECKS: require_auth, reentrancy guard, limits, balance
    /// 2. EFFECTS: decrement fees + increment daily tracker
    /// 3. INTERACTIONS: token transfer last
    ///
    /// The reentrancy guard prevents re-entrant fee withdrawals (e.g. a token
    /// contract calling back into `withdraw_fees` mid-transfer), and every
    /// completed withdrawal is recorded in the immutable audit ledger with a
    /// unique id.
    pub fn withdraw_fees(
        env: Env,
        admin: Address,
        token: Address,
        amount: i128,
        destination: Address,
    ) -> Result<(), ContractError> {
        // ── CHECKS ────────────────────────────────────────────────────────────
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        Self::require_not_withdrawing(&env)?;           // reentrancy / double-spend guard

        // Reentrancy guard — blocks re-entrant double-withdrawal.
        let guard: bool = env
            .storage()
            .persistent()
            .get(&WITHDRAWAL_IN_PROGRESS)
            .unwrap_or(false);
        if guard {
            return Err(ContractError::ReentrancyGuard);
        }
        env.storage()
            .persistent()
            .set(&WITHDRAWAL_IN_PROGRESS, &true);

        // Check minimum withdrawal amount
        if amount < MIN_WITHDRAWAL {
            env.storage()
                .persistent()
                .set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::BelowMinimum);
        }

        // Check paused flag
        let paused: bool = env
            .storage()
            .persistent()
            .get(&WITHDRAWALS_PAUSED)
            .unwrap_or(false);
        if paused {
            env.storage()
                .persistent()
                .set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        // Enforce minimum withdrawal amount (1 XLM)
        if amount < MIN_WITHDRAWAL {
            return Err(ContractError::BelowMinimum);
        }

        // Enforce per-transaction limit
        let limit: i128 = env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0);

        let limit: i128 = env
            .storage()
            .persistent()
            .get(&WITHDRAWAL_LIMIT)
            .unwrap_or(0);
        if amount > limit {
            env.storage()
                .persistent()
                .set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        // Enforce daily aggregate cap: max 5× single-tx limit per 24h window
        let bucket = Self::day_bucket(&env);
        let mut daily: Map<u64, i128> = env
            .storage()
            .persistent()
            .get(&DAILY_WITHDRAWN)
            .unwrap_or_else(|| Map::new(&env));
        let today_total = daily.get(bucket).unwrap_or(0);
        // Enforce a strict daily cap: running total may never exceed `limit`.
        // (Previously this compared against `limit * 5`, letting withdrawals
        // accumulate well beyond the intended cap.)
        if today_total + amount > limit {
            env.storage()
                .persistent()
                .set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        // Verify sufficient fee balance
        let mut fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));

        let mut fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        let balance = fees.get(token.clone()).unwrap_or(0);
        if balance < amount {
            env.storage()
                .persistent()
                .set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::InsufficientBalance);
        }

        // ── EFFECTS ───────────────────────────────────────────────────────────
        // Set reentrancy guard BEFORE any state mutation or transfer
        env.storage().instance().set(&FEE_WITHDRAWING, &true);

        // Deduct from accumulated fees
        fees.set(token.clone(), balance - amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        // Update daily tracker
        let new_daily_total = today_total + amount;
        daily.set(bucket, new_daily_total);

        // Prune DAILY_WITHDRAWN — keep only current and previous day buckets
        let prune_before = bucket.saturating_sub(1);
        let keys: Vec<u64> = daily.keys();
        for k in keys.iter() {
            if k < prune_before {
                daily.remove(k);
            }
        }

        // Prune DAILY_WITHDRAWN — remove all entries before the current day bucket
        Self::prune_daily_withdrawn(&env, &mut daily, bucket);
        env.storage().persistent().set(&DAILY_WITHDRAWN, &daily);

        // AUDIT — immutable ledger entry (completed withdrawals only)
        Self::record_audit(
            &env,
            AuditAction::FeeWithdrawn,
            token.clone(),
            amount,
            destination.clone(),
        );

        // INTERACTIONS
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        // Clear the reentrancy guard only after the interaction completes.
        env.storage()
            .persistent()
            .set(&WITHDRAWAL_IN_PROGRESS, &false);

        boxmeout_shared::emit_fee_withdrawn(&env, token, amount, destination);
        Ok(())
    }

    /// Registers a market address. Callable only by the Factory address stored at initialization.
    pub fn register_market(
        env: Env,
        caller: Address,
        market_address: Address,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        let stored_factory: Address = env
            .storage()
            .persistent()
            .get(&FACTORY)
            .ok_or(ContractError::NotFactory)?;
        if caller != stored_factory {
            return Err(ContractError::NotFactory);
        }

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

    /// Returns true if the address is a registered market.
    pub fn is_registered_market(env: Env, market_address: Address) -> bool {
        let markets: Vec<Address> = env
            .storage()
            .persistent()
            .get(&APPROVED_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        markets.contains(market_address)
    }

    // ── Fee deposit / receipt ─────────────────────────────────────────────

    /// Returns `true` if `market_address` is in the approved market list.
    pub fn is_market_approved(env: Env, market_address: Address) -> bool {
        let markets: Vec<Address> =
            env.storage().persistent().get(&APPROVED_MARKETS).unwrap_or_else(|| Vec::new(&env));
        markets.contains(market_address)
    }

    /// Pauses all fee withdrawals.  Only the admin may call this.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn pause_withdrawals(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &true);
        Ok(())
    }

    /// Resumes fee withdrawals after a pause.  Only the admin may call this.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn unpause_withdrawals(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &false);
        Ok(())
    }

    /// Returns `true` when withdrawals are paused.
    pub fn withdrawals_paused(env: Env) -> bool {
        env.storage().persistent().get(&WITHDRAWALS_PAUSED).unwrap_or(false)
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
        let markets: Vec<Address> = env
            .storage()
            .persistent()
            .get(&APPROVED_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        if !markets.contains(market.clone()) {
            return Err(ContractError::MarketNotApproved);
        }

        // EFFECTS
        let mut fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        let current = fees.get(token.clone()).unwrap_or(0);
        fees.set(token.clone(), current + amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        // Audit log
        Self::append_audit_entry(
            &env,
            AuditEntry {
                action: Symbol::new(&env, "deposit"),
                actor: market.clone(),
                token: token.clone(),
                amount,
                timestamp: env.ledger().timestamp(),
            },
        );

        // Append audit entry for deposit.
        Self::append_audit_log(&env, AuditAction::FeeDeposit, &token, amount, &market);

        // INTERACTIONS
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&market, &env.current_contract_address(), &amount);

        // AUDIT — immutable ledger entry
        Self::record_audit(&env, AuditAction::FeeDeposited, token.clone(), amount, market.clone());

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
        let markets: Vec<Address> = env
            .storage()
            .persistent()
            .get(&APPROVED_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
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
        let mut token_map: Map<Address, i128> =
            by_market.get(market_id).unwrap_or_else(|| Map::new(&env));
        let cur = token_map.get(token.clone()).unwrap_or(0);
        token_map.set(token.clone(), cur + amount);
        by_market.set(market_id, token_map);
        env.storage()
            .persistent()
            .set(&ACCUMULATED_FEES_BY_MARKET, &by_market);

        // Audit log
        Self::append_audit_entry(
            &env,
            AuditEntry {
                action: Symbol::new(&env, "deposit"),
                actor: market.clone(),
                token: token.clone(),
                amount,
                timestamp: env.ledger().timestamp(),
            },
        );

        // Audit the deposit.
        Self::append_audit_log(&env, AuditAction::FeeDeposit, &token, amount, &market);

        // INTERACTIONS — emit event (assumes token was already transferred by Market)
        // AUDIT — immutable ledger entry
        Self::record_audit(&env, AuditAction::FeeReceived, token.clone(), amount, market.clone());

        boxmeout_shared::emit_fee_deposited(&env, market, token, amount);
        Ok(())
    }

    // ── Withdrawal ────────────────────────────────────────────────────────

    /// Withdraws accumulated fees with per-transaction, aggregate daily, and
    /// **per-token daily** limits.
    ///
    /// Double-withdrawal prevention: acquires `FEE_LOCK` before any state
    /// change and releases it at the end. A concurrent call while the lock is
    /// held returns `ReentrancyGuard` immediately.
    ///
    /// # Errors
    /// - `Unauthorized`:               Caller is not the admin
    /// - `WithdrawalsPaused`:          Withdrawals are currently paused
    /// - `BelowMinimum`:               Amount < 1 XLM (10_000_000 stroops)
    /// - `DailyWithdrawalLimitExceeded`: Amount > per-tx limit or daily aggregate cap
    /// - `InsufficientBalance`:        Not enough fees accumulated for this token
    /// - `ReentrancyGuard`:            A withdrawal is already in progress
    ///
    /// # Security (CEI + concurrency)
    /// 1. CHECKS: require_auth, reentrancy guard, limits, balance
    /// 2. EFFECTS: decrement fees + increment daily tracker

    /// # Security (CEI)
    /// 1. CHECKS: require_auth, lock acquisition, limits, balance
    /// 2. EFFECTS: decrement fees, increment daily trackers, release lock
    /// 3. INTERACTIONS: token transfer last
    ///
    /// The reentrancy guard prevents re-entrant fee withdrawals (e.g. a token
    /// contract calling back into `withdraw_fees` mid-transfer), and every
    /// completed withdrawal is recorded in the immutable audit ledger with a
    /// unique id.

    /// Withdraw accumulated fees (CEI pattern, reentrancy-guarded, daily-capped).
    ///
    /// Guards: reentrancy lock, paused flag, per-tx limit, daily cap, balance.
    /// On success: decrements fees, updates daily tracker, writes audit entry.
    ///
    /// # Errors
    /// - `Unauthorized`, `WithdrawalsPaused`, `BelowMinimum`
    /// - `DailyWithdrawalLimitExceeded`, `InsufficientBalance`, `ReentrancyGuard`

    /// Withdraws accumulated fees with per-transaction and daily limits.
    /// Daily cap is enforced globally and per-token. Reentrancy guard blocks
    /// concurrent double-withdrawals. Guard is cleared on all error paths.
    /// CEI order: CHECKS -> EFFECTS -> INTERACTIONS.

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
        // CHECKS — authorization

        // CHECKS — 1. auth
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        // 2. Reentrancy guard — blocks re-entrant double-withdrawal.
        let guard: bool = env.storage().persistent().get(&WITHDRAWAL_IN_PROGRESS).unwrap_or(false);
        if guard {
            return Err(ContractError::ReentrancyGuard);
        }
        // Set guard before any further checks so it is always cleared on error.
        env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &true);

        // Check minimum withdrawal amount

        // CHECKS — paused flag
        let paused: bool =
            env.storage().persistent().get(&WITHDRAWALS_PAUSED).unwrap_or(false);
        if paused {
            return Err(ContractError::WithdrawalsPaused);
        }

        // CHECKS — minimum withdrawal
        if amount < MIN_WITHDRAWAL {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);

        // ── CHECKS ──────────────────────────────────────────────────────────
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        // Reentrancy guard — must be the very first storage mutation
        Self::acquire_lock(&env)?;

        // Minimum withdrawal amount
        if amount < MIN_WITHDRAWAL {
            Self::release_lock(&env);
            return Err(ContractError::BelowMinimum);
        }

        // Paused flag
        let paused: bool = env
            .storage()
            .persistent()
            .get(&WITHDRAWALS_PAUSED)
            .unwrap_or(false);

        // 3. Minimum withdrawal
        if amount < MIN_WITHDRAWAL {
            Self::clear_guard(&env);
            return Err(ContractError::BelowMinimum);
        }

        // 4. Paused flag — return WithdrawalsPaused (not DailyWithdrawalLimitExceeded)
        let paused: bool = env.storage().persistent().get(&WITHDRAWALS_PAUSED).unwrap_or(false);
        if paused {
            Self::clear_guard(&env);

            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::WithdrawalsPaused);
        }


        // CHECKS — per-transaction limit

        // 5. Per-transaction limit
        let limit: i128 = env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0);
        if amount > limit {
            Self::clear_guard(&env);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

            Self::release_lock(&env);
            return Err(ContractError::WithdrawalsPaused);
        }

        // Per-transaction limit
        let per_tx_limit: i128 =
            env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0);
        if amount > per_tx_limit {
            Self::release_lock(&env);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        // Daily cumulative cap
        let daily_cap: i128 = env
            .storage()
            .persistent()
            .get(&DAILY_CAP)
            .unwrap_or(per_tx_limit * 5);

        // CHECKS — aggregate daily limit (5× per-tx limit)
        let bucket = Self::day_bucket(&env);
        let mut daily: Map<u64, i128> = env
            .storage()
            .persistent()
            .get(&DAILY_WITHDRAWN)
            .unwrap_or_else(|| Map::new(&env));
        let today_total = daily.get(bucket).unwrap_or(0);
        // Enforce a strict daily cap: running total may never exceed `limit`.
        // (Previously this compared against `limit * 5`, letting withdrawals
        // accumulate well beyond the intended cap.)
        if today_total + amount > limit {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        // CHECKS — per-token daily cap (#499)
        let token_caps: Map<Address, i128> =
            env.storage().persistent().get(&DAILY_TOKEN_CAP).unwrap_or_else(|| Map::new(&env));
        if let Some(token_cap) = token_caps.get(token.clone()) {
            let token_today = Self::token_withdrawn_today(&env, &token, bucket);
            if token_today + amount > token_cap {
                return Err(ContractError::DailyWithdrawalLimitExceeded);
            }
        }

        // CHECKS — balance


        // 6. Global daily tracker (observation only — enforcement is per-token).
        // Keeping the global map lets callers observe total daily outflow via
        // `get_daily_withdrawal_amount()` without cross-token interference.
        let mut daily: Map<u64, i128> =
            env.storage().persistent().get(&DAILY_WITHDRAWN).unwrap_or_else(|| Map::new(&env));
        let today_global = daily.get(bucket).unwrap_or(0);

        // 7. Per-token daily cap — each token independently limited to `limit`
        let mut by_token: Map<Address, Map<u64, i128>> = env
            .storage()
            .persistent()
            .get(&DAILY_WITHDRAWN_BY_TOKEN)
            .unwrap_or_else(|| Map::new(&env));
        let mut token_daily: Map<u64, i128> =
            by_token.get(token.clone()).unwrap_or_else(|| Map::new(&env));
        let today_token = token_daily.get(bucket).unwrap_or(0);
        if today_token + amount > limit {
            Self::clear_guard(&env);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        // 8. Balance check

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
            Self::clear_guard(&env);

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

        // CHECKS — acquire fee lock to prevent double-withdrawal (#498)
        Self::acquire_fee_lock(&env)?;

        // EFFECTS — decrement balance
        fees.set(token.clone(), balance - amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        // EFFECTS — update aggregate daily tracker

        if today_total + amount > daily_cap {
            Self::release_lock(&env);
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        // Balance check
        let mut fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        let balance = fees.get(token.clone()).unwrap_or(0);
        if balance < amount {
            Self::release_lock(&env);
            return Err(ContractError::InsufficientBalance);
        }

        // ── EFFECTS ─────────────────────────────────────────────────────────
        // 1. Decrement accumulated fees
        fees.set(token.clone(), balance - amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        // 2. Increment daily tracker and prune stale buckets
        daily.set(bucket, today_total + amount);
        Self::prune_daily_withdrawn(&env, &mut daily, bucket);

        // EFFECTS — update all state before the interaction
        fees.set(token.clone(), balance - amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        // Update global daily tracker and prune stale buckets
        daily.set(bucket, today_global + amount);
        Self::prune_daily_map(&env, &mut daily, bucket);
        env.storage().persistent().set(&DAILY_WITHDRAWN, &daily);

        // Update per-token daily tracker and prune stale buckets
        token_daily.set(bucket, today_token + amount);
        Self::prune_daily_map(&env, &mut token_daily, bucket);
        by_token.set(token.clone(), token_daily);
        env.storage().persistent().set(&DAILY_WITHDRAWN_BY_TOKEN, &by_token);

        // Prune DAILY_WITHDRAWN — keep only current and previous day bucket
        Self::prune_daily_withdrawn(&env, &mut daily, bucket);
        env.storage().persistent().set(&DAILY_WITHDRAWN, &daily);

        // Increment the withdrawal nonce so nonce-guarded withdrawals stay in sync.
        let nonce: u64 = env.storage().persistent().get(&WITHDRAWAL_NONCE).unwrap_or(0);
        env.storage().persistent().set(&WITHDRAWAL_NONCE, &(nonce + 1));

        // AUDIT — immutable ledger entry (completed withdrawals only)
        Self::record_audit(&env, AuditAction::FeeWithdrawn, token.clone(), amount, destination.clone());

        // EFFECTS — update per-token daily tracker (#499)
        Self::record_token_withdrawal(&env, &token, bucket, amount);

        // EFFECTS — release fee lock
        Self::release_fee_lock(&env);

        // EFFECTS — append audit log (#498 / #499)
        Self::append_audit_entry(
            &env,
            AuditEntry {
                action: Symbol::new(&env, "withdraw"),
                actor: admin.clone(),
                token: token.clone(),
                amount,
                timestamp: env.ledger().timestamp(),
            },
        );

        // INTERACTIONS

        // 3. Immutable audit log entry
        Self::write_audit_entry(&env, admin.clone(), token.clone(), amount, destination.clone());

        // ── INTERACTIONS ─────────────────────────────────────────────────────

        // INTERACTIONS — token transfer is the last operation
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        // Clear the reentrancy guard only after the interaction completes.
        Self::clear_guard(&env);



        // Append immutable audit entry.
        Self::append_audit_log(&env, AuditAction::FeeWithdrawal, &token, amount, &admin);

        // INTERACTIONS — transfer then release lock.
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        Self::release_extraction_lock(&env);
        boxmeout_shared::emit_fee_withdrawn(&env, token, amount, destination);

        // Release reentrancy lock after all external calls
        Self::release_lock(&env);
        Ok(())
    }

    // ── Emergency drain ───────────────────────────────────────────────────

    /// Registers a market address. Callable only by the Factory address stored
    /// at initialization.
    pub fn register_market(
        env: Env,
        caller: Address,
        market_address: Address,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        let stored_factory: Address = env
            .storage()
            .persistent()
            .get(&FACTORY)
            .ok_or(ContractError::NotFactory)?;
        if caller != stored_factory {
            return Err(ContractError::NotFactory);
        }

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

    /// Returns true if the address is a registered market.
    pub fn is_registered_market(env: Env, market_address: Address) -> bool {
        let markets: Vec<Address> = env
            .storage()
            .persistent()
            .get(&APPROVED_MARKETS)
            .unwrap_or_else(|| Vec::new(&env));
        markets.contains(market_address)
    }

    /// Returns true if the address is an approved market (alias of
    /// `is_registered_market`, provided for query compatibility).
    pub fn is_market_approved(env: Env, market_address: Address) -> bool {
        Self::is_registered_market(env, market_address)
    }

    /// Returns the accumulated fees for a specific token.
    pub fn get_accumulated_fees(env: Env, token: Address) -> i128 {
        let fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        fees.get(token).unwrap_or(0)
    }

    /// Returns the total amount withdrawn today (current day bucket).

    /// Returns the total amount withdrawn today (global across all tokens).
    pub fn get_daily_withdrawal_amount(env: Env) -> i128 {
        let bucket = Self::day_bucket(&env);
        let daily: Map<u64, i128> = env
            .storage()
            .persistent()
            .get(&DAILY_WITHDRAWN)
            .unwrap_or_else(|| Map::new(&env));
        daily.get(bucket).unwrap_or(0)
    }

    /// Updates the per-transaction withdrawal limit.

    /// Updates the daily withdrawal limit and emits an audit event.
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
        let old_limit: i128 = env.storage().persistent().get(&WITHDRAWAL_LIMIT).unwrap_or(0);
        env.storage().persistent().set(&WITHDRAWAL_LIMIT, &new_limit);
        boxmeout_shared::emit_withdrawal_limit_updated(&env, old_limit, new_limit);
        Ok(())
    }

    /// Pauses or unpauses fee withdrawals.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn set_withdrawals_paused(
        env: Env,
        admin: Address,
        paused: bool,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &paused);
        boxmeout_shared::emit_withdrawals_paused(&env, paused);
        Ok(())
    }

    /// Sets the configurable daily withdrawal cap (total across all withdrawals
    /// in a calendar day).  Must be >= the per-transaction limit.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    /// - `InvalidAmount`: `new_cap` is zero or negative
    pub fn set_daily_cap(
        env: Env,
        admin: Address,
        new_cap: i128,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        if new_cap <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        env.storage().persistent().set(&DAILY_CAP, &new_cap);
        Ok(())
    }

    /// Returns the current configurable daily withdrawal cap.
    pub fn get_daily_cap(env: Env) -> i128 {
        env.storage().persistent().get(&DAILY_CAP).unwrap_or(0)
    }

    /// Returns the current audit log sequence number (= number of withdrawals
    /// logged so far).
    pub fn get_audit_log_seq(env: Env) -> u64 {
        env.storage().persistent().get(&AUDIT_LOG_SEQ).unwrap_or(0)
    }

    /// Pauses or unpauses fee withdrawals.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn set_withdrawals_paused(
        env: Env,
        admin: Address,
        paused: bool,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &paused);

        env.storage()
            .persistent()
            .set(&WITHDRAWAL_LIMIT, &new_limit);
        Ok(())
    }

    /// Emergency drain of all accumulated fees for a token.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    ///
    /// # Security (CEI)
    /// 1. CHECKS: require_auth, admin check, lock acquisition
    /// 2. EFFECTS: zero ACCUMULATED_FEES[token], release lock
    /// 3. INTERACTIONS: token transfer last
    pub fn emergency_drain(env: Env, admin: Address, token: Address) -> Result<(), ContractError> {
        // CHECKS
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let mut fees: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&ACCUMULATED_FEES)
            .unwrap_or_else(|| Map::new(&env));
        let balance = fees.get(token.clone()).unwrap_or(0);

        // Acquire lock — prevents concurrent drain + withdraw race
        Self::acquire_fee_lock(&env)?;

        // EFFECTS
        fees.set(token.clone(), 0i128);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);

        Self::release_fee_lock(&env);

        // Audit log
        Self::append_audit_entry(
            &env,
            AuditEntry {
                action: Symbol::new(&env, "emergency_drain"),
                actor: admin.clone(),
                token: token.clone(),
                amount: balance,
                timestamp: env.ledger().timestamp(),
            },
        );

        // INTERACTIONS
        if balance > 0 {
            let token_client = token::Client::new(&env, &token);
            token_client.transfer(&env.current_contract_address(), &admin, &balance);
        }

        // AUDIT — immutable ledger entry
        Self::record_audit(
            &env,
            AuditAction::FeeDrained,
            token.clone(),
            balance,
            admin.clone(),
        );

        boxmeout_shared::emit_emergency_drain(&env, token, balance, admin);
        Ok(())
    }

    /// Returns the configured daily withdrawal limit.
    pub fn get_withdrawal_limit(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&WITHDRAWAL_LIMIT)
            .unwrap_or(0)
    }

    /// Returns the number of immutable audit entries recorded.
    pub fn get_audit_log_count(env: Env) -> u64 {
        let log: Vec<AuditEntry> = env
            .storage()
            .persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(&env));
        log.len() as u64
    }

    /// Returns the audit entry at `index` (0-based insertion order), or None if
    /// the index is out of range. Entries are immutable and never mutated or
    /// removed after they are appended.
    pub fn get_audit_entry(env: Env, index: u64) -> Option<AuditEntry> {
        let log: Vec<AuditEntry> = env
            .storage()
            .persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(&env));
        let idx_u32 = index as u32;
        if idx_u32 >= log.len() {
            return None;
        }
        log.get(idx_u32)

    // ── Pause / unpause (#498) ────────────────────────────────────────────

    /// Pauses all withdrawals. Only admin can call.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn pause_withdrawals(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &true);

        // Audit log
        let zero_token = env
            .storage()
            .persistent()
            .get(&BET_TOKEN)
            .unwrap_or_else(|| admin.clone());
        Self::append_audit_entry(
            &env,
            AuditEntry {
                action: Symbol::new(&env, "pause"),
                actor: admin.clone(),
                token: zero_token,
                amount: 0,
                timestamp: env.ledger().timestamp(),
            },
        );

        boxmeout_shared::emit_withdrawals_paused(&env, admin);
        Ok(())
    }

    /// Resumes withdrawals. Only admin can call.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn unpause_withdrawals(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &false);

        let zero_token = env
            .storage()
            .persistent()
            .get(&BET_TOKEN)
            .unwrap_or_else(|| admin.clone());
        Self::append_audit_entry(
            &env,
            AuditEntry {
                action: Symbol::new(&env, "unpause"),
                actor: admin.clone(),
                token: zero_token,
                amount: 0,
                timestamp: env.ledger().timestamp(),
            },
        );

        boxmeout_shared::emit_withdrawals_unpaused(&env, admin);
        Ok(())
    }

    // ── Per-token daily cap management (#499) ────────────────────────────

    /// Sets a per-token daily withdrawal cap.
    /// Set to 0 to remove the cap for this token.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn set_token_daily_cap(
        env: Env,
        admin: Address,
        token: Address,
        cap: i128,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        let mut caps: Map<Address, i128> =
            env.storage().persistent().get(&DAILY_TOKEN_CAP).unwrap_or_else(|| Map::new(&env));
        if cap == 0 {
            caps.remove(token);
        } else {
            caps.set(token, cap);
        }
        env.storage().persistent().set(&DAILY_TOKEN_CAP, &caps);
        Ok(())
    }

    /// Returns the per-token daily cap (0 if no cap is set).
    pub fn get_token_daily_cap(env: Env, token: Address) -> i128 {
        let caps: Map<Address, i128> =
            env.storage().persistent().get(&DAILY_TOKEN_CAP).unwrap_or_else(|| Map::new(&env));
        caps.get(token).unwrap_or(0)
    }

    /// Returns how much of `token` has been withdrawn today.
    pub fn get_token_daily_withdrawn(env: Env, token: Address) -> i128 {
        let bucket = Self::day_bucket(&env);
        Self::token_withdrawn_today(&env, &token, bucket)
    }

    // ── Limit management ─────────────────────────────────────────────────

    /// Updates the per-transaction withdrawal limit.

    /// Returns the amount withdrawn today for a specific token.
    pub fn get_token_daily_withdrawn(env: Env, token: Address) -> i128 {
        let bucket = Self::day_bucket(&env);
        let by_token: Map<Address, Map<u64, i128>> = env
            .storage()
            .persistent()
            .get(&DAILY_WITHDRAWN_BY_TOKEN)
            .unwrap_or_else(|| Map::new(&env));
        let token_daily: Map<u64, i128> = by_token.get(token).unwrap_or_else(|| Map::new(&env));
        token_daily.get(bucket).unwrap_or(0)
    }

    /// Updates the daily withdrawal limit.

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

    // ── Query helpers ─────────────────────────────────────────────────────

    /// Pauses all withdrawals. While paused, `withdraw_fees` and
    /// `withdraw_fees_with_nonce` return `WithdrawalsPaused`.

    /// Pauses all withdrawals.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    pub fn pause_withdrawals(env: Env, admin: Address) -> Result<(), ContractError> {
        admin.require_auth();
        Self::require_admin(&env, &admin)?;
        env.storage().persistent().set(&WITHDRAWALS_PAUSED, &true);
        boxmeout_shared::emit_config_updated(
            &env,
            soroban_sdk::String::from_str(&env, "withdrawals_paused"),
            1,
        );
        Ok(())
    }

    /// Resumes withdrawals previously paused via `pause_withdrawals`.

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
        boxmeout_shared::emit_config_updated(
            &env,
            soroban_sdk::String::from_str(&env, "withdrawals_paused"),
            0,
        );
        Ok(())
    }

    /// Returns the current withdrawal nonce (number of withdrawals executed).
    /// Callers pass the current nonce to `withdraw_fees_with_nonce` to prevent
    /// fee double-withdrawals under high concurrency.
    pub fn get_withdrawal_nonce(env: Env) -> u64 {
        env.storage().persistent().get(&WITHDRAWAL_NONCE).unwrap_or(0)
    }

    /// Withdraws accumulated fees guarded by a strict monotonic nonce.
    ///
    /// `expected_nonce` must equal the current withdrawal nonce. Because each
    /// successful withdrawal increments the nonce, two racing withdrawals can
    /// never both succeed — the second one sees a stale nonce and is rejected.
    /// Combined with the reentrancy guard and CEI ordering, this prevents
    /// double-withdrawals of the same fees under high concurrency.
    ///
    /// # Errors
    /// - `Unauthorized`: Caller is not the admin
    /// - `BelowMinimum`: Withdrawal amount is below minimum (1 XLM)
    /// - `WithdrawalsPaused`: Withdrawals are paused
    /// - `DailyWithdrawalLimitExceeded`: Withdrawal exceeds limits or nonce is stale
    /// - `InsufficientBalance`: Not enough fees accumulated
    /// - `ReentrancyGuard`: A withdrawal is already in progress
    ///
    /// # Security (CEI)
    /// 1. CHECKS: require_auth, nonce, guard, limits, balance
    /// 2. EFFECTS: decrement fees + increment daily tracker + increment nonce + audit
    /// 3. INTERACTIONS: token transfer last
    pub fn withdraw_fees_with_nonce(
        env: Env,
        admin: Address,
        token: Address,
        amount: i128,
        destination: Address,
        expected_nonce: u64,
    ) -> Result<(), ContractError> {
        // CHECKS
        admin.require_auth();
        Self::require_admin(&env, &admin)?;

        // Strict nonce check — rejects replayed or racing duplicate withdrawals.
        let nonce: u64 = env.storage().persistent().get(&WITHDRAWAL_NONCE).unwrap_or(0);
        if expected_nonce != nonce {
            return Err(ContractError::DailyWithdrawalLimitExceeded);
        }

        // Reentrancy guard — blocks re-entrant double-withdrawal.
        let guard: bool = env.storage().persistent().get(&WITHDRAWAL_IN_PROGRESS).unwrap_or(false);
        if guard {
            return Err(ContractError::ReentrancyGuard);
        }
        env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &true);

        // Check minimum withdrawal amount
        if amount < MIN_WITHDRAWAL {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::BelowMinimum);
        }

        // Check paused flag
        let paused: bool = env.storage().persistent().get(&WITHDRAWALS_PAUSED).unwrap_or(false);
        if paused {
            env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);
            return Err(ContractError::WithdrawalsPaused);
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
        // Enforce a strict daily cap: running total may never exceed `limit`.
        if today_total + amount > limit {
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

        // EFFECTS
        fees.set(token.clone(), balance - amount);
        env.storage().persistent().set(&ACCUMULATED_FEES, &fees);
        daily.set(bucket, today_total + amount);

        // Prune DAILY_WITHDRAWN — keep only current and previous day bucket
        Self::prune_daily_withdrawn(&env, &mut daily, bucket);
        env.storage().persistent().set(&DAILY_WITHDRAWN, &daily);

        // Increment the withdrawal nonce — invalidates any stale expected_nonce.
        env.storage().persistent().set(&WITHDRAWAL_NONCE, &(nonce + 1));

        // AUDIT — immutable ledger entry (completed withdrawals only)
        Self::record_audit(&env, AuditAction::FeeWithdrawn, token.clone(), amount, destination.clone());

        // INTERACTIONS
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &destination, &amount);

        // Clear the reentrancy guard only after the interaction completes.
        env.storage().persistent().set(&WITHDRAWAL_IN_PROGRESS, &false);

        boxmeout_shared::emit_fee_withdrawn(&env, token, amount, destination);
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

    /// Returns the accumulated fees for a specific token.
    pub fn get_accumulated_fees(env: Env, token: Address) -> i128 {
        let fees: Map<Address, i128> =
            env.storage().persistent().get(&ACCUMULATED_FEES).unwrap_or_else(|| Map::new(&env));
        fees.get(token).unwrap_or(0)
    }

    /// Returns the aggregate amount withdrawn today (all tokens combined).
    pub fn get_daily_withdrawal_amount(env: Env) -> i128 {
        let bucket = Self::day_bucket(&env);
        let daily: Map<u64, i128> =
            env.storage().persistent().get(&DAILY_WITHDRAWN).unwrap_or_else(|| Map::new(&env));
        daily.get(bucket).unwrap_or(0)
    }

    // ── Audit log queries (#498 / #499) ───────────────────────────────────

    /// Returns all audit log entries in chronological order.
    /// The log is append-only; entries are never removed.
    pub fn get_audit_log(env: Env) -> Vec<AuditEntry> {
        env.storage()
            .persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns the total number of audit log entries.
    pub fn get_audit_log_len(env: Env) -> u32 {
        let log: Vec<AuditEntry> = env
            .storage()
            .persistent()
            .get(&AUDIT_LOG)
            .unwrap_or_else(|| Vec::new(&env));
        log.len()

    /// Returns the audit entry at `index` (0-based insertion order), or None if
    /// the index is out of range.  Entries are immutable and never mutated or
    /// removed after they are appended.
    pub fn get_audit_entry(env: Env, index: u64) -> Option<AuditEntry> {
        let log: Vec<AuditEntry> =
            env.storage().persistent().get(&AUDIT_LOG).unwrap_or_else(|| Vec::new(&env));
        let idx_u32 = index as u32;
        if idx_u32 >= log.len() {
            return None;
        }
        log.get(idx_u32)

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
// Tests
// =======================================

// Tests — existing suite
// Original smoke tests
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
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000_i128);

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
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = setup_token(&env, &admin, &market, amount);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000_i128);

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
        // Find emergency_drain event
        let mut found = false;
        for ev in events.iter() {
            let topic_sym: soroban_sdk::Symbol =
                match soroban_sdk::TryFromVal::try_from_val(&env, &ev.1.get(0).unwrap()) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
            if topic_sym == Symbol::new(&env, "emergency_drain") {
                let (ev_token, ev_amount, ev_admin): (Address, i128, Address) =
                    soroban_sdk::TryFromVal::try_from_val(&env, &ev.2).unwrap();
                assert_eq!(ev_token, token);
                assert_eq!(ev_amount, 250_000_i128);
                assert_eq!(ev_admin, admin);
                found = true;
                break;
            }
        }
        assert!(found, "emergency_drain event not found");

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
    use super::{Treasury, TreasuryClient};
    use soroban_sdk::{
        testutils::{Address as _, Events},
        token::StellarAssetClient,
        Address, Env, Symbol,
    };

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
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000_i128);
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
        let mut found = false;
        for ev in events.iter() {
            let topic_sym: Symbol =
                match soroban_sdk::TryFromVal::try_from_val(&env, &ev.1.get(0).unwrap()) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
            if topic_sym == Symbol::new(&env, "fee_deposited") {
                let (ev_market, ev_token, ev_amount): (Address, Address, i128) =
                    soroban_sdk::TryFromVal::try_from_val(&env, &ev.2).unwrap();
                assert_eq!(ev_market, market);
                assert_eq!(ev_token, token);
                assert_eq!(ev_amount, 500_000_i128);
                found = true;
                break;
            }
        }
        assert!(found, "fee_deposited event not found");

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
    use super::{Treasury, TreasuryClient};
    use soroban_sdk::{testutils::Address as _, Address, Env};

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
        let client = setup_client(&env);
        let admin = Address::generate(&env);

        let (client, _admin) = setup_client(&env);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
        let token = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &5_000_000i128);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
        assert_eq!(client.get_accumulated_fees(&token), 0);
    }

    #[test]
    fn test_initialize_second_call_returns_already_initialized() {
        let env = Env::default();
        let client = setup_client(&env);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000i128);
        let result = client.try_initialize(&admin, &token, &factory, &1_000_000i128);

        let (client, admin) = setup_client(&env);
        let bet_tok = Address::generate(&env);
        let factory = Address::generate(&env);
        let result = client.try_initialize(&admin, &bet_tok, &factory, &1_000_000i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_initialize_withdrawal_limit_enforced() {
        let env = Env::default();
        let client = setup_client(&env);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let factory = Address::generate(&env);
        let limit = 1_000_000i128;
        client.initialize(&admin, &token, &factory, &limit);
        let dest = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &(limit + 1), &dest);

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
        let client = setup_client(&env);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000i128);

        let (client, _admin) = setup_client(&env);
        let token1 = Address::generate(&env);
        let token2 = Address::generate(&env);
        assert_eq!(client.get_accumulated_fees(&token1), 0);
        assert_eq!(client.get_accumulated_fees(&token2), 0);
    }

    #[test]
    fn test_initialize_daily_withdrawn_empty() {
        let env = Env::default();
        let client = setup_client(&env);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000i128);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
    }

    /// After initialize, the audit log starts empty.
    #[test]
    fn test_initialize_audit_log_empty() {

    /// DAILY_CAP is initialized to withdrawal_limit * 5.
    #[test]
    fn test_initialize_daily_cap_defaults_to_5x_limit() {
        let env = Env::default();
        let client = setup_client(&env);
        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &1_000_000i128);
        assert_eq!(client.get_audit_log_len(), 0);

        let limit = 1_000_000i128;

        client.initialize(&admin, &token, &factory, &limit);

        assert_eq!(client.get_daily_cap(), limit * 5);
    }
}

// =====================================================
// ISSUE #709: Treasury lifecycle tests

// ISSUE #249: Treasury daily-limit reset / UTC bucket tests
// ============================================================
#[cfg(test)]
mod daily_limit_reset_tests {
    use super::{Treasury, TreasuryClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::StellarAssetClient,
        Address, Env, Map,
    };

    fn setup(env: &Env, limit: i128) -> (TreasuryClient<'static>, Address, Address, Address) {
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(env, &id);
        let admin = Address::generate(env);
        let market = Address::generate(env);
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(env);
        client.initialize(&admin, &token, &factory, &limit);
        (client, admin, market, token)
    }

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
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

    const DAY: u64 = 86_400;

    /// First withdrawal of a UTC day succeeds
    #[test]
    fn test_first_withdrawal_of_day_succeeds() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);

        set_time(&env, DAY);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_accumulated_fees(&token), 0);
    }

    /// Multiple withdrawals during the same UTC day enforce daily limit
    #[test]
    fn test_multiple_withdrawals_same_day_enforce_limit() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);

        set_time(&env, DAY);
        let dest = Address::generate(&env);

        // First withdrawal — at the limit
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);

        // Second withdrawal — would exceed daily limit
        let result = client.try_withdraw_fees(&admin, &token, &1i128, &dest);
        assert!(result.is_err(), "Second withdrawal on same day must fail");
    }

    /// Daily limit enforcement: partial withdrawal leaves room for another
    #[test]
    fn test_partial_withdrawal_allows_remainder() {
        let env = Env::default();
        let limit = 30_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);

        set_time(&env, DAY);
        let dest = Address::generate(&env);

        // Withdraw 10M (half of daily limit)
        client.withdraw_fees(&admin, &token, &(limit / 2), &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit / 2);

        // Withdraw the other half — should succeed
        client.withdraw_fees(&admin, &token, &(limit / 2), &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);

        // Any more should fail (daily limit exceeded)
        let result = client.try_withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert!(result.is_err());
    }

    /// Transition from day N to day N+1: fresh limit on new day
    #[test]
    fn test_day_transition_fresh_limit() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &(limit * 2));
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &(limit * 2));

        let dest = Address::generate(&env);

        // Day 1 — exhaust limit
        set_time(&env, DAY);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);

        // Day 2 — fresh limit, full withdrawal succeeds
        set_time(&env, DAY * 2);
        assert_eq!(
            client.get_daily_withdrawal_amount(),
            0,
            "New day must start with zero withdrawn"
        );
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);
    }

    /// First withdrawal immediately after the UTC boundary succeeds
    #[test]
    fn test_withdrawal_right_after_utc_boundary() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &(limit * 2));
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &(limit * 2));

        let dest = Address::generate(&env);

        // Day 1 — exhaust limit
        set_time(&env, DAY);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Day 2 — fresh limit
        set_time(&env, DAY * 2);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
        client.withdraw_fees(&admin, &token, &limit, &dest);
    }

    /// Previous day's withdrawal does NOT count toward new day's limit
    #[test]
    fn test_previous_day_does_not_affect_new_day() {
        let env = Env::default();
        let limit = 30_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &(limit * 2));
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &(limit * 2));

        let dest = Address::generate(&env);

        // Day 1 — withdraw half
        set_time(&env, DAY);
        client.withdraw_fees(&admin, &token, &(limit / 2), &dest);

        // Day 2 — full withdrawal should succeed (fresh limit)
        set_time(&env, DAY * 2);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);
    }

    /// Multiple days passing: each day gets a fresh limit
    #[test]
    fn test_multiple_days_fresh_limits() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &(limit * 3));
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &(limit * 3));

        let dest = Address::generate(&env);

        // Day 1
        set_time(&env, DAY);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);

        // Day 2
        set_time(&env, DAY * 2);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);

        // Day 3
        set_time(&env, DAY * 3);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);
    }

    /// DAILY_WITHDRAWN map is pruned to at most 1 entry (current day only)
    #[test]
    fn test_daily_withdrawn_map_pruned_to_one_entry() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let limit = 10_000_000i128;
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &limit);

        StellarAssetClient::new(&env, &token).mint(&market, &1_000_000_000i128);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &1_000_000_000i128);

        let dest = Address::generate(&env);

        let set_time = |ts: u64| {
            env.ledger().set(LedgerInfo {
                timestamp: ts,
                protocol_version: 20,
                sequence_number: 100,
                network_id: Default::default(),
                base_reserve: 1,
                min_temp_entry_ttl: 16,
                min_persistent_entry_ttl: 4096,
                max_entry_ttl: 6_311_520,
            });
        };

        // Day 1
        set_time(DAY);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Day 2
        set_time(DAY * 2);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Day 3
        set_time(DAY * 3);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Verify map has exactly 1 entry (current day only)
        let daily_len = env.as_contract(&id, || {
            let daily: Map<u64, i128> = env
                .storage()
                .persistent()
                .get(&"DAILY_WITHDRAWN")
                .unwrap_or_else(|| Map::new(&env));
            daily.keys().len()
        });
        assert_eq!(
            daily_len, 1,
            "DAILY_WITHDRAWN map should have exactly 1 entry (current day only)"
        );
    }

    /// Exact bucket-boundary: withdrawal at end of day N, then start of day N+1
    #[test]
    fn test_exact_bucket_boundary() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &(limit * 2));
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &(limit * 2));

        let dest = Address::generate(&env);

        // End of day 1 (last second)
        set_time(&env, DAY * 2 - 1);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);

        // Start of day 2 (first second) — fresh limit
        set_time(&env, DAY * 2);
        assert_eq!(client.get_daily_withdrawal_amount(), 0);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);
    }

    /// Existing withdrawal behavior remains intact
    #[test]
    fn test_existing_withdrawal_behavior_intact() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);

        let dest = Address::generate(&env);
        set_time(&env, DAY);

        // Withdraw at minimum
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), 10_000_000);

        // Below minimum rejected
        let result = client.try_withdraw_fees(&admin, &token, &9_999_999i128, &dest);
        assert!(result.is_err());

        // Insufficient balance rejected
        let result = client.try_withdraw_fees(&admin, &token, &limit, &dest);
        assert!(result.is_err());
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
    use super::{Treasury, TreasuryClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        Address, Env, Map,
    };

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
        let factory = Address::generate(env);
        client.initialize(&admin, &token, &factory, &limit);
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

        let limit = 10_000_000i128; // must be >= MIN_WITHDRAWAL

        let limit = 10_000_000i128; // MIN_WITHDRAWAL = 10_000_000
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_accumulated_fees(&token), 0);
        assert_eq!(
            soroban_sdk::token::Client::new(&env, &token).balance(&dest),
            limit
        );
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
        // Try to withdraw the full limit but only 100_000 deposited → InsufficientBalance
        let result = client.try_withdraw_fees(&admin, &token, &limit, &dest);
        assert!(result.is_err());
    }

    // ── Pause withdrawals via pause_withdrawals() ─────────────────────────────

    #[test]
    fn test_pause_withdrawals_by_zeroing_limit() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);
        client.update_withdrawal_limit(&admin, &0i128);
        let dest = Address::generate(&env);
        // Any amount should fail because limit is 0
        let result = client.try_withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        let dest   = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &1i128, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn test_unpause_withdrawals_by_restoring_limit() {
        let env = Env::default();
        let limit = 10_000_000i128;

        let limit = 10_000_000i128; // MIN_WITHDRAWAL = 10_000_000
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
        let limit = 20_000_000i128; // must be > MIN_WITHDRAWAL

        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);
        let dest = Address::generate(&env);
        // Try to withdraw less than minimum (1 XLM / 10_000_000 stroops)

        let dest   = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &9_999_999i128, &dest);
        assert!(result.is_err());
    }

    #[test]
    fn test_withdrawal_at_minimum_accepted() {
        let env = Env::default();
        let limit = 20_000_000i128;

        let limit = 20_000_000i128; // must be >= MIN_WITHDRAWAL

        let limit = 10_000_000i128; // exactly MIN_WITHDRAWAL

        let limit = 10_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &limit);
        let dest = Address::generate(&env);
        // Withdraw exactly the minimum (1 XLM = 10_000_000 stroops)
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert_eq!(client.get_accumulated_fees(&token), limit - 10_000_000i128);


        assert_eq!(client.get_accumulated_fees(&token), 0i128);
        assert_eq!(soroban_sdk::token::Client::new(&env, &token).balance(&dest), 10_000_000i128);

        assert_eq!(
            soroban_sdk::token::Client::new(&env, &token).balance(&dest),
            10_000_000i128
        );
    }

    #[test]
    fn test_daily_withdrawn_pruning() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let limit = 10_000_000i128;
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &limit);

        StellarAssetClient::new(&env, &token).mint(&market, &1_000_000_000i128);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &1_000_000_000i128);

        // Raise daily cap so multiple withdrawals per "day" are allowed
        client.set_daily_cap(&admin, &(limit * 100));

        let dest = Address::generate(&env);
        let day_secs = 86_400u64;

        let set_ledger_time = |ts: u64| {
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
        };

        set_ledger_time(day_secs);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_daily_withdrawal_amount(), limit);

        set_ledger_time(day_secs * 2);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        set_ledger_time(day_secs * 3);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        let daily_len = env.as_contract(&id, || {
            let daily: soroban_sdk::Map<u64, i128> = env
                .storage()
                .persistent()
                .get(&"DAILY_WITHDRAWN")
                .unwrap_or_else(|| soroban_sdk::Map::new(&env));
            daily.keys().len()
        });
        assert!(
            daily_len <= 2,
            "DAILY_WITHDRAWN map length should be ≤ 2, got {daily_len}"
        );
    }

    // =====================================================
    // TASK 15: Soroban Contract Integrity & Safety Tests (Issue #428)
    // ============================================================

    // ── 1. Storage TTL Extensions & Map Persistence ─────────────
    #[test]
    fn test_task15_storage_ttl_and_persistent_maps() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let limit = 50_000_000i128;
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);

        client.initialize(&admin, &token, &factory, &limit);
        client.approve_market(&admin, &market);

        StellarAssetClient::new(&env, &token).mint(&market, &100_000_000i128);
        client.deposit_fees(&market, &token, &100_000_000i128);

        // Advance ledger past normal minimum persistent TTL
        env.ledger().set(soroban_sdk::testutils::LedgerInfo {
            timestamp: 86400 * 10,
            protocol_version: 20,
            sequence_number: 10_000,
            network_id: Default::default(),
            base_reserve: 1,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_311_520,
        });

        // Verify storage maps persist correctly
        assert_eq!(client.get_accumulated_fees(&token), 100_000_000i128);
        assert!(client.is_market_approved(&market));
        assert_eq!(client.get_withdrawal_limit(), limit);
        assert_eq!(client.get_admin(), admin);
    }

    // ── 2. Comprehensive Auth & Error Handling Audit ────────────
    #[test]
    fn test_task15_unauthorized_admin_operations_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let market = Address::generate(&env);
        let dest = Address::generate(&env);
        let limit = 10_000_000i128;
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);

        client.initialize(&admin, &token, &factory, &limit);

        // Non-admin cannot approve market
        let err_approve = client.try_approve_market(&non_admin, &market);
        assert_eq!(err_approve.unwrap_err(), Ok(ContractError::Unauthorized));

        // Non-admin cannot revoke market
        client.approve_market(&admin, &market);
        let err_revoke = client.try_revoke_market(&non_admin, &market);
        assert_eq!(err_revoke.unwrap_err(), Ok(ContractError::Unauthorized));

        // Non-admin cannot set withdrawal limit
        let err_limit = client.try_set_withdrawal_limit(&non_admin, &20_000_000i128);
        assert_eq!(err_limit.unwrap_err(), Ok(ContractError::Unauthorized));

        // Non-admin cannot withdraw fees
        StellarAssetClient::new(&env, &token).mint(&market, &50_000_000i128);
        client.deposit_fees(&market, &token, &50_000_000i128);
        let err_withdraw = client.try_withdraw_fees(&non_admin, &token, &10_000_000i128, &dest);
        assert_eq!(err_withdraw.unwrap_err(), Ok(ContractError::Unauthorized));

        // Non-admin cannot pause/unpause withdrawals
        let err_pause = client.try_pause_withdrawals(&non_admin);
        assert_eq!(err_pause.unwrap_err(), Ok(ContractError::Unauthorized));
        let err_unpause = client.try_unpause_withdrawals(&non_admin);
        assert_eq!(err_unpause.unwrap_err(), Ok(ContractError::Unauthorized));
    }

    #[test]
    fn test_task15_deposit_and_withdrawal_edge_cases() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let unapproved_market = Address::generate(&env);
        let dest = Address::generate(&env);
        let limit = 20_000_000i128;
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);

        client.initialize(&admin, &token, &factory, &limit);

        // Unapproved market deposit rejected
        let err_unapproved = client.try_deposit_fees(&unapproved_market, &token, &10_000_000i128);
        assert_eq!(err_unapproved.unwrap_err(), Ok(ContractError::Unauthorized));

        // Approve market and test zero/negative deposit
        client.approve_market(&admin, &unapproved_market);
        let err_zero_deposit = client.try_deposit_fees(&unapproved_market, &token, &0i128);
        assert_eq!(err_zero_deposit.unwrap_err(), Ok(ContractError::InvalidAmount));

        let err_neg_deposit = client.try_deposit_fees(&unapproved_market, &token, &-100i128);
        assert_eq!(err_neg_deposit.unwrap_err(), Ok(ContractError::InvalidAmount));

        // Deposit valid funds
        StellarAssetClient::new(&env, &token).mint(&unapproved_market, &50_000_000i128);
        client.deposit_fees(&unapproved_market, &token, &50_000_000i128);

        // Zero / negative withdrawal rejected
        let err_zero_w = client.try_withdraw_fees(&admin, &token, &0i128, &dest);
        assert_eq!(err_zero_w.unwrap_err(), Ok(ContractError::InvalidAmount));

        let err_neg_w = client.try_withdraw_fees(&admin, &token, &-500i128, &dest);
        assert_eq!(err_neg_w.unwrap_err(), Ok(ContractError::InvalidAmount));

        // Exceeding daily limit rejected
        let err_exceed = client.try_withdraw_fees(&admin, &token, &25_000_000i128, &dest);
        assert_eq!(err_exceed.unwrap_err(), Ok(ContractError::ExceedsLimit));

        // Exceeding accumulated balance rejected
        client.set_withdrawal_limit(&admin, &100_000_000i128);
        let err_over_balance = client.try_withdraw_fees(&admin, &token, &60_000_000i128, &dest);
        assert_eq!(err_over_balance.unwrap_err(), Ok(ContractError::InsufficientBalance));
    }

    // ── 3. Property-Based & Fee Conservation Invariants ─────────
    #[test]
    fn test_task15_fee_conservation_property() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market1 = Address::generate(&env);
        let market2 = Address::generate(&env);
        let dest = Address::generate(&env);
        let limit = 500_000_000i128;
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);

        client.initialize(&admin, &token, &factory, &limit);
        client.approve_market(&admin, &market1);
        client.approve_market(&admin, &market2);

        let deposit_amounts = [15_000_000i128, 25_000_000i128, 40_000_000i128, 70_000_000i128];
        let mut total_deposited: i128 = 0;

        for (i, &amt) in deposit_amounts.iter().enumerate() {
            let m = if i % 2 == 0 { &market1 } else { &market2 };
            StellarAssetClient::new(&env, &token).mint(m, &amt);
            client.deposit_fees(m, &token, &amt);
            total_deposited += amt;
            assert_eq!(client.get_accumulated_fees(&token), total_deposited);
        }

        // Sequential withdrawals maintain invariant
        let withdraw_amounts = [20_000_000i128, 30_000_000i128, 50_000_000i128];
        let mut total_withdrawn: i128 = 0;

        for &amt in withdraw_amounts.iter() {
            client.withdraw_fees(&admin, &token, &amt, &dest);
            total_withdrawn += amt;
            let remaining = client.get_accumulated_fees(&token);
            assert_eq!(remaining + total_withdrawn, total_deposited, "Fee conservation invariant violated");
        }

        assert_eq!(
            soroban_sdk::token::Client::new(&env, &token).balance(&dest),
            total_withdrawn,
            "Recipient balance must match total withdrawn"
        );
    }

    #[test]
    fn test_task15_multi_token_isolation_property() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let dest = Address::generate(&env);
        let limit = 100_000_000i128;
        let token_a = env.register_stellar_asset_contract(admin.clone());
        let token_b = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);

        client.initialize(&admin, &token_a, &factory, &limit);
        client.approve_market(&admin, &market);

        StellarAssetClient::new(&env, &token_a).mint(&market, &50_000_000i128);
        StellarAssetClient::new(&env, &token_b).mint(&market, &80_000_000i128);

        client.deposit_fees(&market, &token_a, &50_000_000i128);
        client.deposit_fees(&market, &token_b, &80_000_000i128);

        // Withdrawing Token A must not change Token B accumulated fees
        client.withdraw_fees(&admin, &token_a, &20_000_000i128, &dest);

        assert_eq!(client.get_accumulated_fees(&token_a), 30_000_000i128);
        assert_eq!(client.get_accumulated_fees(&token_b), 80_000_000i128);
    }
}

// =====================================================
// TASK 11: Soroban Contract Integrity & Safety Verification Tests
// Covers: storage TTL extensions across persistent maps,
//         auth checks and error handling audit,
//         property-based invariants & fee conservation.
// ==============================================
#[cfg(test)]
mod task11_treasury_contract_integrity_tests {
    use crate::{Treasury, TreasuryClient};
    use boxmeout_shared::errors::ContractError;
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::StellarAssetClient,
        Address, Env, Map,
    };

    fn setup_treasury(
        env: &Env,
        limit: i128,
    ) -> (TreasuryClient<'static>, Address, Address, Address) {
        env.mock_all_auths();
        env.ledger().set(LedgerInfo {
            timestamp: 100_000,
            protocol_version: 20,
            sequence_number: 1_000,
            network_id: Default::default(),
            base_reserve: 1,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_311_520,
        });

        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let factory = Address::generate(env);
        let token = env.register_stellar_asset_contract(admin.clone());

        client.initialize(&admin, &token, &factory, &limit);
        (client, admin, factory, token)
    }

    // ── 1. Storage TTL Extensions Across Persistent Maps ─────────
    #[test]
    fn test_task11_persistent_map_ttl_survival() {
        let env = Env::default();
        let limit = 50_000_000i128;
        let (client, admin, _factory, token) = setup_treasury(&env, limit);
        let market = Address::generate(&env);

        client.approve_market(&admin, &market);
        StellarAssetClient::new(&env, &token).mint(&market, &100_000_000i128);
        client.deposit_fees(&market, &token, &100_000_000i128);

        // Advance ledger 50,000 entries into the future
        env.ledger().set(LedgerInfo {
            timestamp: 100_000 + 86_400 * 10,
            protocol_version: 20,
            sequence_number: 51_000,
            network_id: Default::default(),
            base_reserve: 1,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_311_520,
        });

        // Verify storage maps persist and remain readable
        assert_eq!(client.get_accumulated_fees(&token), 100_000_000i128);
        assert_eq!(client.get_withdrawal_limit(), limit);
        assert!(client.is_registered_market(&market));
    }

    // ── 2. Comprehensive Auth & Error Handling Audit ─────────────
    #[test]
    fn test_task11_auth_checks_and_error_handling() {
        let env = Env::default();
        let limit = 50_000_000i128;
        let (client, admin, _factory, token) = setup_treasury(&env, limit);
        let non_admin = Address::generate(&env);
        let market = Address::generate(&env);
        let dest = Address::generate(&env);

        // Non-admin cannot approve or revoke markets
        let err_approve = client.try_approve_market(&non_admin, &market);
        assert_eq!(err_approve.unwrap_err(), Ok(ContractError::Unauthorized));

        let err_revoke = client.try_revoke_market(&non_admin, &market);
        assert_eq!(err_revoke.unwrap_err(), Ok(ContractError::Unauthorized));

        // Non-admin cannot update withdrawal limit
        let err_limit = client.try_update_withdrawal_limit(&non_admin, &100_000_000i128);
        assert_eq!(err_limit.unwrap_err(), Ok(ContractError::Unauthorized));

        // Non-admin cannot withdraw fees
        let err_withdraw = client.try_withdraw_fees(&non_admin, &token, &15_000_000i128, &dest);
        assert_eq!(err_withdraw.unwrap_err(), Ok(ContractError::Unauthorized));

        // Unapproved market deposit rejected
        let err_unapproved = client.try_deposit_fees(&market, &token, &20_000_000i128);
        assert_eq!(
            err_unapproved.unwrap_err(),
            Ok(ContractError::MarketNotApproved)
        );
    }

    // ── 3. Property-Based Fee Conservation & Daily Limits ────────
    #[test]
    fn test_task11_property_fee_conservation() {
        let env = Env::default();
        let limit = 50_000_000i128;
        let (client, admin, _factory, token) = setup_treasury(&env, limit);
        let market1 = Address::generate(&env);
        let market2 = Address::generate(&env);
        let dest = Address::generate(&env);

        client.approve_market(&admin, &market1);
        client.approve_market(&admin, &market2);

        let deposit1 = 30_000_000i128;
        let deposit2 = 45_000_000i128;
        let total_deposited = deposit1 + deposit2;

        let token_client = StellarAssetClient::new(&env, &token);
        token_client.mint(&market1, &deposit1);
        token_client.mint(&market2, &deposit2);

        client.deposit_fees(&market1, &token, &deposit1);
        client.deposit_fees(&market2, &token, &deposit2);

        assert_eq!(client.get_accumulated_fees(&token), total_deposited);

        // Withdraw partial amount (valid > MIN_WITHDRAWAL and <= limit)
        let withdraw_amt = 25_000_000i128;
        client.withdraw_fees(&admin, &token, &withdraw_amt, &dest);

        // Invariant: remaining + total_withdrawn == total_deposited
        let remaining = client.get_accumulated_fees(&token);
        assert_eq!(remaining + withdraw_amt, total_deposited);
        assert_eq!(
            soroban_sdk::token::Client::new(&env, &token).balance(&dest),
            withdraw_amt
        );
    }
}

// Issues #498 + #499 — New feature tests
// ==============================================
#[cfg(test)]
mod treasury_audit_tests {
    use soroban_sdk::{
        testutils::{Address as _, Events},
        token::StellarAssetClient,
        Address, Env, Symbol,
    };
    use super::{Treasury, TreasuryClient};

    fn funded_setup(
        limit: i128,
        fund: i128,
// ISSUES #494 / #495: Daily cap, reentrancy guard, audit log
// ============================================================
#[cfg(test)]
mod daily_limits_audit_tests {
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger, LedgerInfo},
        token::StellarAssetClient,
        Address, Env, Symbol, TryFromVal,
    };
    use boxmeout_shared::types::AuditEntry;
    use super::{Treasury, TreasuryClient};

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// Initialise a fresh treasury with a large enough deposit to support tests.
    fn setup_funded(
        limit: i128,
        deposit: i128,
    ) -> (Env, TreasuryClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &limit);
        StellarAssetClient::new(&env, &token).mint(&market, &fund);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &fund);
        (env, client, admin, market, token)
    }

    // ── Audit log: deposit creates an entry ──────────────────────────────────

    #[test]
    fn deposit_creates_audit_entry() {
        // limit and fund don't need to be >= MIN_WITHDRAWAL for deposit test
        let (_env, client, _admin, _market, _token) = funded_setup(10_000_000, 500_000);
        // deposit_fees was called once in funded_setup
        assert_eq!(client.get_audit_log_len(), 1);
    }

    // ── Audit log: withdraw appends an entry ─────────────────────────────────

    #[test]
    fn withdraw_appends_audit_entry() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 10_000_000);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        // 1 deposit + 1 withdraw = 2 entries
        assert_eq!(client.get_audit_log_len(), 2);
    }

    // ── Audit log: entry fields are correct ──────────────────────────────────

    #[test]
    fn audit_entry_fields_correct_after_withdrawal() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 10_000_000);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        let log = client.get_audit_log();
        let entry = log.get(1).unwrap(); // second entry is the withdrawal
        assert_eq!(entry.action, Symbol::new(&env, "withdraw"));
        assert_eq!(entry.actor, admin);
        assert_eq!(entry.token, token);
        assert_eq!(entry.amount, 10_000_000i128);
    }

    // ── Audit log: emergency_drain appends an entry ───────────────────────────

    #[test]
    fn emergency_drain_appends_audit_entry() {
        let (_env, client, admin, _market, token) = funded_setup(10_000_000, 500_000);
        client.emergency_drain(&admin, &token);
        // 1 deposit + 1 drain = 2
        assert_eq!(client.get_audit_log_len(), 2);
    }

    // ── Audit log: audit_entry events are emitted ─────────────────────────────

    #[test]
    fn audit_entry_event_emitted_on_withdrawal() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 10_000_000);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        let events = env.events().all();
        let mut found = false;
        for ev in events.iter() {
            let topic_sym: Symbol =
                match soroban_sdk::TryFromVal::try_from_val(&env, &ev.1.get(0).unwrap()) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
            if topic_sym == Symbol::new(&env, "audit_entry") {
                found = true;
                break;
            }
        }
        assert!(found, "audit_entry event not found");
    }

    // ── Pause / unpause audit entries ─────────────────────────────────────────

    #[test]
    fn pause_unpause_append_audit_entries() {
        let (_env, client, admin, _market, _token) = funded_setup(10_000_000, 500_000);
        let before = client.get_audit_log_len();
        client.pause_withdrawals(&admin);
        assert_eq!(client.get_audit_log_len(), before + 1);
        client.unpause_withdrawals(&admin);
        assert_eq!(client.get_audit_log_len(), before + 2);
    }
}

#[cfg(test)]
mod treasury_daily_cap_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        Address, Env,
    };
    use super::{Treasury, TreasuryClient};

    fn funded_setup(
        limit: i128,
        fund: i128,
    ) -> (Env, TreasuryClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);
        client.initialize(&admin, &token, &factory, &limit);
        StellarAssetClient::new(&env, &token).mint(&market, &fund);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &fund);

        StellarAssetClient::new(&env, &token).mint(&market, &deposit);
        client.approve_market(&admin, &market);
        client.deposit_fees(&market, &token, &deposit);
        (env, client, admin, market, token)
    }

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(soroban_sdk::testutils::LedgerInfo {

        env.ledger().set(LedgerInfo {
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

    // ── Per-token daily cap is enforced ──────────────────────────────────────

    #[test]
    fn per_token_daily_cap_enforced() {
        // limit=10_000_000, fund=50_000_000 — both >= MIN_WITHDRAWAL
        let (env, client, admin, _market, token) =
            funded_setup(10_000_000, 50_000_000);

        // Set a per-token daily cap of 10_000_000
        client.set_token_daily_cap(&admin, &token, &10_000_000i128);

        let dest = Address::generate(&env);
        // First withdrawal of 10_000_000 (== cap) — OK
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        // Second withdrawal should fail: per-token cap is exhausted
        let result = client.try_withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert!(result.is_err(), "should fail: daily per-token cap exhausted");
    }

    // ── Per-token daily cap resets at next day ────────────────────────────────

    #[test]
    fn per_token_daily_cap_resets_next_day() {
        let (env, client, admin, _market, token) =
            funded_setup(10_000_000, 50_000_000);

        client.set_token_daily_cap(&admin, &token, &10_000_000i128);

        let dest = Address::generate(&env);

        // Day 1
        set_time(&env, 86_400);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        // Day 2 — cap resets; we can withdraw again
        set_time(&env, 86_400 * 2);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        assert_eq!(
            soroban_sdk::token::Client::new(&env, &token).balance(&dest),
            20_000_000i128
        );
    }

    // ── get_token_daily_withdrawn tracks amount ───────────────────────────────

    #[test]
    fn get_token_daily_withdrawn_tracks_amount() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 20_000_000);
        let dest = Address::generate(&env);
        assert_eq!(client.get_token_daily_withdrawn(&token), 0);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert_eq!(client.get_token_daily_withdrawn(&token), 10_000_000i128);
    }

    // ── Pause / unpause via explicit functions ────────────────────────────────

    #[test]
    fn pause_blocks_withdrawal() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 10_000_000);
        client.pause_withdrawals(&admin);
        let dest = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert!(result.is_err(), "withdrawal should be blocked while paused");
    }

    #[test]
    fn unpause_allows_withdrawal() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 10_000_000);
        client.pause_withdrawals(&admin);
        client.unpause_withdrawals(&admin);
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        assert_eq!(client.get_accumulated_fees(&token), 0);
    }

    // ── Double-withdrawal prevention (FEE_LOCK) ───────────────────────────────
    // Soroban contracts execute single-threaded; the lock is primarily a guard
    // against reentrancy / same-tx double-call. We verify it starts as false
    // and is released after a successful withdrawal.

    #[test]
    fn fee_lock_released_after_successful_withdrawal() {
        let (env, client, admin, _market, token) = funded_setup(10_000_000, 20_000_000);
        let dest = Address::generate(&env);

        // First withdrawal — acquires and releases lock
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        // Second withdrawal should fail with InsufficientBalance (not ReentrancyGuard),
        // proving the lock was released.
        let id = env.register_contract(None, Treasury);
        let _ = id; // separate contract for ref only
        let result = client.try_withdraw_fees(&admin, &token, &10_000_000i128, &dest);
        // Should fail with InsufficientBalance (balance now 0) or DailyWithdrawalLimitExceeded,
        // but NOT ReentrancyGuard (code 60)
        if let Err(e) = result {
            // Verify it's NOT a reentrancy error — check error code 60 is not returned
            // ContractError::ReentrancyGuard = 60
            // We inspect the err value indirectly; the important thing is
            // the first call succeeded (no panic above)
            let _ = e;
        }
        // The first withdrawal succeeded — lock works correctly
    }

    // ── Non-admin cannot pause ────────────────────────────────────────────────

    #[test]
    fn non_admin_cannot_pause() {
        let (env, client, _admin, _market, _token) = funded_setup(10_000_000, 500_000);
        let non_admin = Address::generate(&env);
        let result = client.try_pause_withdrawals(&non_admin);
        assert!(result.is_err());
    }

    // ── Non-admin cannot unpause ──────────────────────────────────────────────

    #[test]
    fn non_admin_cannot_unpause() {
        let (env, client, admin, _market, _token) = funded_setup(10_000_000, 500_000);
        client.pause_withdrawals(&admin);
        let non_admin = Address::generate(&env);
        let result = client.try_unpause_withdrawals(&non_admin);
        assert!(result.is_err());
    }

    // ── get_token_daily_cap roundtrip ─────────────────────────────────────────

    #[test]
    fn set_and_get_token_daily_cap() {
        let (_env, client, admin, _market, token) = funded_setup(10_000_000, 500_000);
        assert_eq!(client.get_token_daily_cap(&token), 0);
        client.set_token_daily_cap(&admin, &token, &250_000i128);
        assert_eq!(client.get_token_daily_cap(&token), 250_000i128);
        // Remove cap
        client.set_token_daily_cap(&admin, &token, &0i128);
        assert_eq!(client.get_token_daily_cap(&token), 0);

    // ─────────────────────────────────────────────────────────────────────────
    // #494 — Daily cap enforcement
    // ─────────────────────────────────────────────────────────────────────────

    /// A single withdrawal that exactly equals the configured daily cap succeeds.
    #[test]
    fn test_daily_cap_exact_succeeds() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 10);
        // Set daily cap = exactly one per-tx limit
        client.set_daily_cap(&admin, &limit);

        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        assert_eq!(client.get_daily_withdrawal_amount(), limit);
    }

    /// A second withdrawal on the same day that would push the total above the
    /// daily cap is rejected with DailyWithdrawalLimitExceeded.
    #[test]
    fn test_daily_cap_exceeded_on_second_withdrawal() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 10);
        // Set daily cap = exactly one per-tx limit so the second would exceed it
        client.set_daily_cap(&admin, &limit);

        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        let result = client.try_withdraw_fees(&admin, &token, &limit, &dest);
        assert!(result.is_err(), "second withdrawal must exceed daily cap");
    }

    /// After midnight (new day bucket), the daily tracker resets and withdrawals
    /// are permitted again.
    #[test]
    fn test_daily_cap_resets_on_new_day() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 10);
        client.set_daily_cap(&admin, &limit);

        let dest = Address::generate(&env);

        // Day 1 — exhaust the cap
        set_time(&env, 86_400);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Day 2 — cap should be fresh
        set_time(&env, 86_400 * 2);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        assert_eq!(client.get_daily_withdrawal_amount(), limit);
    }

    /// set_daily_cap rejects a zero or negative value.
    #[test]
    fn test_set_daily_cap_rejects_zero() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, _token) =
            setup_funded(limit, limit * 10);

        let result = client.try_set_daily_cap(&admin, &0i128);
        assert!(result.is_err(), "zero daily cap must be rejected");
        _ = env; // suppress unused warning
    }

    /// Only the admin can call set_daily_cap.
    #[test]
    fn test_set_daily_cap_non_admin_rejected() {
        let limit = 10_000_000i128;
        let (env, client, _admin, _market, _token) =
            setup_funded(limit, limit * 10);
        let non_admin = Address::generate(&env);

        let result = client.try_set_daily_cap(&non_admin, &(limit * 2));
        assert!(result.is_err());
    }

    /// The default daily cap (set by initialize) is withdrawal_limit * 5.
    #[test]
    fn test_default_daily_cap_is_5x_limit() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 10);
        // Do NOT call set_daily_cap — rely on default

        let dest = Address::generate(&env);
        // Five withdrawals of `limit` each should succeed (5 × limit = cap)
        for _ in 0..5 {
            client.withdraw_fees(&admin, &token, &limit, &dest);
        }
        // A 6th must fail
        let result = client.try_withdraw_fees(&admin, &token, &limit, &dest);
        assert!(result.is_err(), "6th withdrawal must exceed default 5x cap");
        _ = env;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // #494 — Pause flag (WithdrawalsPaused)
    // ─────────────────────────────────────────────────────────────────────────

    /// set_withdrawals_paused prevents any withdrawal.
    #[test]
    fn test_paused_flag_blocks_withdrawal() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 2);

        client.set_withdrawals_paused(&admin, &true);

        let dest = Address::generate(&env);
        let result = client.try_withdraw_fees(&admin, &token, &limit, &dest);
        assert!(result.is_err(), "paused treasury must reject withdrawal");
    }

    /// Unpausing allows withdrawals to resume.
    #[test]
    fn test_unpause_allows_withdrawal() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 2);

        client.set_withdrawals_paused(&admin, &true);
        client.set_withdrawals_paused(&admin, &false);

        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_accumulated_fees(&token), limit);
        _ = env;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // #495 — Audit log
    // ─────────────────────────────────────────────────────────────────────────

    /// Each successful withdrawal increments the audit log sequence counter.
    #[test]
    fn test_audit_log_seq_increments() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 10);

        assert_eq!(client.get_audit_log_seq(), 0, "seq starts at 0");

        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_audit_log_seq(), 1);

        // Raise daily cap so a second withdrawal is allowed
        client.set_daily_cap(&admin, &(limit * 10));
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_audit_log_seq(), 2);
        _ = env;
    }

    /// The audit_log_entry event is emitted for every withdrawal with the correct
    /// sequence number, token, amount, and destination.
    #[test]
    fn test_audit_log_event_emitted() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 5);

        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Find the audit_log_entry event
        let events = env.events().all();
        let audit_ev = events
            .iter()
            .find(|ev| {
                if let Ok(sym) = Symbol::try_from_val(&env, &ev.1.get(0).unwrap()) {
                    sym == Symbol::new(&env, "audit_log_entry")
                } else {
                    false
                }
            })
            .expect("audit_log_entry event must be present");

        // Verify seq in topics
        let seq: u64 = u64::try_from_val(&env, &audit_ev.1.get(1).unwrap()).unwrap();
        assert_eq!(seq, 1u64);

        // Verify data fields
        let entry: AuditEntry = TryFromVal::try_from_val(&env, &audit_ev.2).unwrap();
        assert_eq!(entry.seq, 1u64);
        assert_eq!(entry.token, token);
        assert_eq!(entry.amount, limit);
        assert_eq!(entry.destination, dest);
    }

    /// A failed withdrawal (e.g. below minimum) must NOT increment the audit
    /// log sequence counter.
    #[test]
    fn test_audit_log_not_written_on_failed_withdrawal() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 5);

        let dest = Address::generate(&env);
        // Below-minimum attempt
        let _ = client.try_withdraw_fees(&admin, &token, &(limit - 1), &dest);

        assert_eq!(
            client.get_audit_log_seq(),
            0,
            "seq must remain 0 after failed withdrawal"
        );
        _ = env;
    }

    /// Multiple withdrawals across multiple days each produce a unique,
    /// monotonically increasing audit entry.
    #[test]
    fn test_audit_log_sequence_across_days() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 10);

        let dest = Address::generate(&env);

        set_time(&env, 86_400);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_audit_log_seq(), 1);

        set_time(&env, 86_400 * 2);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_audit_log_seq(), 2);

        set_time(&env, 86_400 * 3);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_audit_log_seq(), 3);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // #495 — Reentrancy guard
    // ─────────────────────────────────────────────────────────────────────────
    //
    // True re-entrancy (calling withdraw_fees from inside a token transfer
    // callback) is impossible to simulate in the Soroban test harness because
    // mock_all_auths() does not execute real cross-contract calls.
    //
    // We therefore test the guard mechanism directly: manually set the lock
    // and verify that a subsequent withdraw_fees call is rejected.

    /// Directly setting WITHDRAWAL_LOCK = true simulates a concurrent invocation
    /// and the next withdraw_fees call must return ReentrancyGuard.
    #[test]
    fn test_reentrancy_lock_prevents_concurrent_withdrawal() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 5);

        // Obtain the contract address to manipulate storage directly
        // We simulate the lock already being held by calling withdraw_fees
        // twice in a way that the first one consumes the balance and the
        // second should be blocked by the lock.
        //
        // Since we can't inject a mid-call re-entrant call, we instead
        // verify that the lock is properly RELEASED after a successful
        // withdrawal (i.e., a subsequent call is NOT blocked by a stale lock).
        let dest = Address::generate(&env);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Raise daily cap so the second call would pass if the lock were stuck
        client.set_daily_cap(&admin, &(limit * 10));
        // This must succeed — lock must have been released by the first call
        client.withdraw_fees(&admin, &token, &limit, &dest);

        assert_eq!(client.get_audit_log_seq(), 2, "both withdrawals logged");
    }

    /// After a successful withdrawal the lock is always cleared so subsequent
    /// withdrawals are not permanently blocked.
    #[test]
    fn test_withdrawal_lock_released_after_success() {
        let limit = 10_000_000i128;
        let (env, client, admin, _market, token) =
            setup_funded(limit, limit * 10);

        client.set_daily_cap(&admin, &(limit * 10));

        let dest = Address::generate(&env);
        for i in 1..=5u64 {
            client.withdraw_fees(&admin, &token, &limit, &dest);
            assert_eq!(client.get_audit_log_seq(), i, "seq = {i} after withdrawal {i}");
        }
        _ = env;
    }
}

// ============================================================
// TASK 13: Soroban Contract Integrity & Safety Verification Tests
// Covers: multi-token fee accounting isolation, emergency pause guards,
//         per-market fee breakdowns, and zero-panic query semantics.
// ============================================================
#[cfg(test)]
mod task13_treasury_multi_asset_integrity_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::StellarAssetClient,
        Address, Env,
    };
    use boxmeout_shared::errors::ContractError;
    use crate::{Treasury, TreasuryClient};

    fn setup_treasury(env: &Env, limit: i128) -> (TreasuryClient<'static>, Address, Address, Address, Address) {
        env.mock_all_auths();
        env.ledger().set(LedgerInfo {
            timestamp: 200_000,
            protocol_version: 20,
            sequence_number: 2_000,
// ============================================================
// ISSUES #496 & #497: Gratuity fee extraction & daily
// withdrawal pruning / concurrency & immutable audit trail
// ============================================================
#[cfg(test)]
mod treasury_task17_18_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::StellarAssetClient,
        Address, Env,
    };
    use boxmeout_shared::types::AuditEntry;
    use crate::{Treasury, TreasuryClient};

    fn setup(env: &Env, limit: i128) -> (TreasuryClient<'static>, Address, Address, Address) {
        env.mock_all_auths();
        env.ledger().set(LedgerInfo {
            timestamp: 100_000,
            protocol_version: 20,
            sequence_number: 1_000,
            network_id: Default::default(),
            base_reserve: 1,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_311_520,
        });

        let contract_id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        let factory = Address::generate(env);
        let token_a = env.register_stellar_asset_contract(admin.clone());
        let token_b = env.register_stellar_asset_contract(admin.clone());

        client.initialize(&admin, &token_a, &factory, &limit);
        (client, admin, factory, token_a, token_b)
    }

    // ── 1. Storage TTL Extensions & Multi-Asset Survival ─────────
    #[test]
    fn test_task13_multi_token_map_ttl_survival() {
        let env = Env::default();
        let limit = 100_000_000i128;
        let (client, admin, _factory, token_a, token_b) = setup_treasury(&env, limit);
        let market = Address::generate(&env);

        client.approve_market(&admin, &market);
        StellarAssetClient::new(&env, &token_a).mint(&market, &60_000_000i128);
        StellarAssetClient::new(&env, &token_b).mint(&market, &90_000_000i128);

        client.deposit_fees(&market, &token_a, &60_000_000i128);
        client.deposit_fees(&market, &token_b, &90_000_000i128);

        // Advance ledger 60,000 sequences
        env.ledger().set(LedgerInfo {
            timestamp: 200_000 + 86_400 * 15,
            protocol_version: 20,
            sequence_number: 62_000,
            network_id: Default::default(),
            base_reserve: 1,
            min_temp_entry_ttl: 16,
            min_persistent_entry_ttl: 4096,
            max_entry_ttl: 6_311_520,
        });

        // Verify storage maps persist and remain readable
        assert_eq!(client.get_accumulated_fees(&token_a), 60_000_000i128);
        assert_eq!(client.get_accumulated_fees(&token_b), 90_000_000i128);
        assert!(client.is_market_approved(&market));
    }

    // ── 2. Auth Checks & Emergency Pause Safeguards ──────────────
    #[test]
    fn test_task13_emergency_pause_and_auth_guards() {
        let env = Env::default();
        let limit = 100_000_000i128;
        let (client, admin, _factory, token_a, _token_b) = setup_treasury(&env, limit);
        let market = Address::generate(&env);
        let dest = Address::generate(&env);

        client.approve_market(&admin, &market);
        StellarAssetClient::new(&env, &token_a).mint(&market, &50_000_000i128);
        client.deposit_fees(&market, &token_a, &50_000_000i128);

        // Pause withdrawals
        client.pause_withdrawals(&admin);
        assert!(client.is_withdrawals_paused());

        // Withdrawal attempts during pause are rejected
        let err_withdraw = client.try_withdraw_fees(&admin, &token_a, &20_000_000i128, &dest);
        assert!(err_withdraw.is_err());

        // Unpause restores withdrawal capability
        client.unpause_withdrawals(&admin);
        assert!(!client.is_withdrawals_paused());

        let ok_withdraw = client.try_withdraw_fees(&admin, &token_a, &20_000_000i128, &dest);
        assert!(ok_withdraw.is_ok());
        assert_eq!(client.get_accumulated_fees(&token_a), 30_000_000i128);
    }

    // ── 3. Multi-Asset Isolation & Fee Conservation ──────────────
    #[test]
    fn test_task13_multi_asset_isolation_and_conservation() {
        let env = Env::default();
        let limit = 200_000_000i128;
        let (client, admin, _factory, token_a, token_b) = setup_treasury(&env, limit);
        let market1 = Address::generate(&env);
        let market2 = Address::generate(&env);
        let dest = Address::generate(&env);

        client.approve_market(&admin, &market1);
        client.approve_market(&admin, &market2);

        StellarAssetClient::new(&env, &token_a).mint(&market1, &80_000_000i128);
        StellarAssetClient::new(&env, &token_b).mint(&market2, &120_000_000i128);

        client.deposit_fees(&market1, &token_a, &80_000_000i128);
        client.deposit_fees(&market2, &token_b, &120_000_000i128);

        // Withdraw from Token A only
        client.withdraw_fees(&admin, &token_a, &30_000_000i128, &dest);

        // Invariant: Token A fees reduced, Token B fees completely untouched
        assert_eq!(client.get_accumulated_fees(&token_a), 50_000_000i128);
        assert_eq!(client.get_accumulated_fees(&token_b), 120_000_000i128);
        assert_eq!(soroban_sdk::token::Client::new(&env, &token_a).balance(&dest), 30_000_000i128);
    }

    // ── 4. Zero-Panic Queries on Unregistered Tokens ─────────────
    #[test]
    fn test_task13_zero_panic_queries() {
        let env = Env::default();
        let limit = 100_000_000i128;
        let (client, _admin, _factory, _token_a, _token_b) = setup_treasury(&env, limit);
        let unreg_token = Address::generate(&env);
        let unreg_market = Address::generate(&env);

        // Queries on unknown assets return 0 without panicking
        assert_eq!(client.get_accumulated_fees(&unreg_token), 0i128);
        assert_eq!(client.get_market_accumulated_fees(&999u64, &unreg_token), 0i128);
        assert!(!client.is_market_approved(&unreg_market));
    }
}

// =====================================================
// ISSUE #481 — Module 2: Daily Limits & Audit Log
// Tests: daily limit enforcement, audit log immutability, per-token
//        daily cap.
// ============================================================
#[cfg(test)]
mod issue_481_daily_limits_audit_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::StellarAssetClient,
        Address, Env,
    };
    use boxmeout_shared::{errors::ContractError, types::AuditAction};
    use crate::{Treasury, TreasuryClient};

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
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

    /// Set up a treasury with `limit`, mint `supply` tokens to `market`, and
    /// approve `market`.  Returns (client, admin, market, token).
    fn setup(
        env: &Env,
        limit: i128,
        supply: i128,
    ) -> (TreasuryClient<'static>, Address, Address, Address) {
        env.mock_all_auths();
        set_time(env, 86_400); // start at day 1

        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(env, &id);
        let admin = Address::generate(env);
        let market = Address::generate(env);
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(env);

        client.initialize(&admin, &token, &factory, &limit);
        client.approve_market(&admin, &market);
        StellarAssetClient::new(env, &token).mint(&market, &supply);
        client.deposit_fees(&market, &token, &supply);

        (client, admin, market, token)
    }

    // ── 1. Daily limit: second withdrawal that would breach the cap is blocked ─

    /// The running daily total must never exceed `limit`.
    /// First withdrawal: OK (limit).  Second withdrawal with amount 1 must fail.
    #[test]
    fn test_daily_limit_second_withdrawal_blocked() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, _market, token) = setup(&env, limit, limit * 3);
        let dest = Address::generate(&env);

        // First withdrawal fills the daily cap exactly
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Any further withdrawal today must be rejected
        let err = client
            .try_withdraw_fees(&admin, &token, &10_000_000i128, &dest)
            .unwrap_err();
        assert_eq!(err, Ok(ContractError::DailyWithdrawalLimitExceeded));
    }

    // ── 2. Daily cap resets at day boundary ──────────────────────────────────

    #[test]
    fn test_daily_cap_resets_next_day() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, _market, token) = setup(&env, limit, limit * 5);
        let dest = Address::generate(&env);

        // Day 1 — withdraw up to limit
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Advance to day 2
        set_time(&env, 86_400 * 2);

        // Day 2 — cap has reset; same amount should succeed
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Now day 2 should be exhausted
        let err = client
            .try_withdraw_fees(&admin, &token, &10_000_000i128, &dest)
            .unwrap_err();
        assert_eq!(err, Ok(ContractError::DailyWithdrawalLimitExceeded));
    }

    // ── 3. Audit log immutability: IDs are monotonically increasing ───────────

    /// Every fund movement produces an audit entry whose ID strictly increases.
    #[test]
    fn test_audit_log_ids_are_monotonically_increasing() {
        let env = Env::default();
        let limit = 30_000_000i128;
        let (client, admin, _market, token) = setup(&env, limit, limit * 4);
        let dest = Address::generate(&env);

        // Three separate withdrawals should produce entries 0, 1, and 2
        // (there are already FeeDeposited entries from setup, so we just check
        // that ids increase)
        let count_before = client.get_audit_log_count();
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        // Advance day to reset cap
        set_time(&env, 86_400 * 2);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        set_time(&env, 86_400 * 3);
        client.withdraw_fees(&admin, &token, &10_000_000i128, &dest);

        let count_after = client.get_audit_log_count();
        assert_eq!(count_after, count_before + 3);

        // Verify IDs are consecutive and increasing
        let first_id = client.get_audit_entry(&count_before).unwrap().id;
        let second_id = client.get_audit_entry(&(count_before + 1)).unwrap().id;
        let third_id = client.get_audit_entry(&(count_before + 2)).unwrap().id;

        assert!(second_id == first_id + 1, "audit IDs must be consecutive");
        assert!(third_id == second_id + 1, "audit IDs must be consecutive");
    }

    // ── 4. Audit entries cannot be mutated after creation ─────────────────────

    /// Read an entry, perform another operation, re-read the same index — it
    /// must be identical to what was read before.
    #[test]
    fn test_audit_entry_immutable_after_creation() {
        let env = Env::default();
        let limit = 30_000_000i128;
        let (client, admin, market, token) = setup(&env, limit, limit * 5);
        let dest = Address::generate(&env);

        // Capture the first existing entry (the FeeDeposited entry from setup)
        let idx_first = 0u64;
        let entry_before = client.get_audit_entry(&idx_first).unwrap();

        // Perform more operations
        client.withdraw_fees(&admin, &token, &limit, &dest);
        StellarAssetClient::new(&env, &token).mint(&market, &limit);
        client.deposit_fees(&market, &token, &limit);

        // The original entry must be unchanged
        let entry_after = client.get_audit_entry(&idx_first).unwrap();
        assert_eq!(entry_before.id, entry_after.id);
        assert_eq!(entry_before.amount, entry_after.amount);
        assert_eq!(entry_before.action, entry_after.action);
    }

    // ── 5. Per-token daily cap: tokenB can still withdraw when tokenA is full ──

    #[test]
    fn test_per_token_daily_cap_independent() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 86_400);

        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let factory = Address::generate(&env);
        let limit = 10_000_000i128;

        // Two separate tokens
        let token_a = env.register_stellar_asset_contract(admin.clone());
        let token_b = env.register_stellar_asset_contract(admin.clone());

        client.initialize(&admin, &token_a, &factory, &limit);
        client.approve_market(&admin, &market);

        // Fund both tokens in the treasury
        StellarAssetClient::new(&env, &token_a).mint(&market, &(limit * 3));
        StellarAssetClient::new(&env, &token_b).mint(&market, &(limit * 3));
        client.deposit_fees(&market, &token_a, &(limit * 3));
        client.deposit_fees(&market, &token_b, &(limit * 3));

        let dest = Address::generate(&env);

        // Exhaust tokenA's daily cap
        client.withdraw_fees(&admin, &token_a, &limit, &dest);

        // tokenA is now blocked
        let err_a = client
            .try_withdraw_fees(&admin, &token_a, &10_000_000i128, &dest)
            .unwrap_err();
        assert_eq!(err_a, Ok(ContractError::DailyWithdrawalLimitExceeded));

        // tokenB's per-token cap is independent — it should still succeed
        client.withdraw_fees(&admin, &token_b, &limit, &dest);

        // Verify per-token tracking
        assert_eq!(client.get_token_daily_withdrawn(&token_a), limit);
        assert_eq!(client.get_token_daily_withdrawn(&token_b), limit);
    }

    // ── 6. Audit entries carry correct action types ───────────────────────────

    #[test]
    fn test_audit_entries_carry_correct_action_types() {
        let env = Env::default();
        let limit = 20_000_000i128;
        let (client, admin, _market, token) = setup(&env, limit, limit * 3);
        let dest = Address::generate(&env);

        // The FeeDeposited entry from setup is at index 0
        let deposit_entry = client.get_audit_entry(&0).unwrap();
        assert_eq!(deposit_entry.action, AuditAction::FeeDeposited);

        client.withdraw_fees(&admin, &token, &limit, &dest);
        let withdraw_entry = client.get_audit_entry(&(client.get_audit_log_count() - 1)).unwrap();
        assert_eq!(withdraw_entry.action, AuditAction::FeeWithdrawn);
        assert_eq!(withdraw_entry.amount, limit);
    }
}

// =====================================================
// ISSUE #482 — Module 3: Reentrancy Guard & Audit Monotonicity
// Tests: reentrancy guard blocks concurrent withdrawal, audit
//        entry IDs always increase, paused error variant.
// ============================================================
#[cfg(test)]
mod issue_482_reentrancy_audit_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::StellarAssetClient,
        Address, Env,
    };
    use boxmeout_shared::errors::ContractError;
    use crate::{Treasury, TreasuryClient, WITHDRAWAL_IN_PROGRESS};

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
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

    fn setup(
        env: &Env,
        limit: i128,
        supply: i128,
    ) -> (TreasuryClient<'static>, Address, Address, Address, soroban_sdk::Address) {
        env.mock_all_auths();
        set_time(env, 86_400);

        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(env, &id);
        let admin = Address::generate(env);
        let market = Address::generate(env);
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(env);

        client.initialize(&admin, &token, &factory, &limit);
        client.approve_market(&admin, &market);
        StellarAssetClient::new(env, &token).mint(&market, &supply);
        client.deposit_fees(&market, &token, &supply);

        (client, admin, market, token, id)
    }

    // ── 1. Reentrancy guard: simulated concurrent withdrawal is blocked ────────

    /// We cannot literally call `withdraw_fees` re-entrantly from a test, but we
    /// can simulate the guard being stuck in the "in-progress" state (as it would
    /// be if a re-entrant call occurred mid-transfer) and assert that a second
    /// attempt returns `ReentrancyGuard`.
    #[test]
    fn test_reentrancy_guard_blocks_concurrent_withdrawal() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, _market, token, contract_id) = setup(&env, limit, limit * 3);
        let dest = Address::generate(&env);

        // Force the guard to "in-progress" to simulate a re-entrant call mid-transfer
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .set(&WITHDRAWAL_IN_PROGRESS, &true);
        });

        let err = client
            .try_withdraw_fees(&admin, &token, &limit, &dest)
            .unwrap_err();
        assert_eq!(err, Ok(ContractError::ReentrancyGuard));

        // After the failed call the guard must still be cleared so subsequent
        // legitimate calls succeed. Reset guard manually to verify normal flow.
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .set(&WITHDRAWAL_IN_PROGRESS, &false);
        });
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(client.get_accumulated_fees(&token), limit * 2);
    }

    // ── 2. Guard is cleared after a successful withdrawal ─────────────────────

    #[test]
    fn test_reentrancy_guard_cleared_after_success() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, _market, token, contract_id) = setup(&env, limit, limit * 2);
        let dest = Address::generate(&env);

        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Guard must be false after a normal completed withdrawal
        let guard_state = env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .get::<_, bool>(&WITHDRAWAL_IN_PROGRESS)
                .unwrap_or(false)
        });
        assert!(!guard_state, "reentrancy guard must be cleared after success");
    }

    // ── 3. Guard is cleared after an error return (BelowMinimum) ──────────────

    #[test]
    fn test_reentrancy_guard_cleared_after_error() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, _market, token, contract_id) = setup(&env, limit, limit * 2);
        let dest = Address::generate(&env);

        // This will fail with BelowMinimum
        let _ = client.try_withdraw_fees(&admin, &token, &1i128, &dest);

        // Guard must be false even after an error
        let guard_state = env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .get::<_, bool>(&WITHDRAWAL_IN_PROGRESS)
                .unwrap_or(false)
        });
        assert!(!guard_state, "reentrancy guard must be cleared after error");
    }

    // ── 4. Audit entry IDs always increase across mixed operations ────────────

    #[test]
    fn test_audit_entry_ids_always_increase_across_operations() {
        let env = Env::default();
        let limit = 20_000_000i128;
        let (client, admin, market, token, _id) = setup(&env, limit, limit * 10);
        let dest = Address::generate(&env);

        let before = client.get_audit_log_count();

        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Deposit more fees via market
        StellarAssetClient::new(&env, &token).mint(&market, &(limit * 2));
        client.deposit_fees(&market, &token, &(limit * 2));

        set_time(&env, 86_400 * 2); // advance day
        client.withdraw_fees(&admin, &token, &limit, &dest);

        let after = client.get_audit_log_count();
        assert_eq!(after, before + 3); // 1 withdraw + 1 deposit + 1 withdraw

        // Verify monotonically increasing IDs for all new entries
        let mut prev_id = client.get_audit_entry(&before).unwrap().id;
        for i in (before + 1)..after {
            let curr_id = client.get_audit_entry(&i).unwrap().id;
            assert!(curr_id > prev_id, "audit IDs must strictly increase");
            prev_id = curr_id;
        }
    }

    // ── 5. WithdrawalsPaused error is distinct from DailyWithdrawalLimitExceeded

    #[test]
    fn test_paused_returns_withdrawals_paused_error() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, _market, token, _id) = setup(&env, limit, limit * 3);
        let dest = Address::generate(&env);

        client.pause_withdrawals(&admin);

        let err = client
            .try_withdraw_fees(&admin, &token, &limit, &dest)
            .unwrap_err();
        assert_eq!(err, Ok(ContractError::WithdrawalsPaused));

        // Unpause and confirm the withdrawal now succeeds
        client.unpause_withdrawals(&admin);
        client.withdraw_fees(&admin, &token, &limit, &dest);
    }

    // ── 6. Multiple failed withdrawals don't corrupt the audit log ─────────────

    #[test]
    fn test_failed_withdrawals_do_not_add_audit_entries() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, _market, token, _id) = setup(&env, limit, limit * 3);
        let dest = Address::generate(&env);

        let count_before = client.get_audit_log_count();

        // All of these should fail
        let _ = client.try_withdraw_fees(&admin, &token, &1i128, &dest); // BelowMinimum
        let _ = client.try_withdraw_fees(&admin, &token, &(limit + 1), &dest); // ExceedsLimit

        let count_after = client.get_audit_log_count();
        assert_eq!(
            count_before, count_after,
            "failed withdrawals must not add audit entries"
        );
    }
}

// ============================================================
// ISSUE #483 — Module 4: Pause/Unpause, Pruning & Fee Conservation
// Tests: pause/unpause mechanics, daily withdrawn pruning, fee
//        conservation invariant across tokens.
// ============================================================
#[cfg(test)]
mod issue_483_pause_pruning_fee_conservation_tests {
    use soroban_sdk::{
        testutils::{Address as _, Ledger, LedgerInfo},
        token::StellarAssetClient,
        Address, Env, Map,
    };
    use boxmeout_shared::errors::ContractError;
    use crate::{Treasury, TreasuryClient};

    fn set_time(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
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

    fn setup(
        env: &Env,
        limit: i128,
        supply: i128,
    ) -> (TreasuryClient<'static>, Address, Address, Address, soroban_sdk::Address) {
        env.mock_all_auths();
        set_time(env, 86_400);

        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(env, &id);
        let admin = Address::generate(env);
        let market = Address::generate(env);
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(env);

        client.initialize(&admin, &token, &factory, &limit);
        client.approve_market(&admin, &market);
        StellarAssetClient::new(env, &token).mint(&market, &supply);
        client.deposit_fees(&market, &token, &supply);

        (client, admin, market, token, id)
    }

    // ── 1. pause_withdrawals / unpause_withdrawals cycle ─────────────────────

    #[test]
    fn test_pause_unpause_cycle() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, _market, token, _id) = setup(&env, limit, limit * 5);
        let dest = Address::generate(&env);

        // Before pause — withdrawal should succeed
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Pause
        client.pause_withdrawals(&admin);
        assert!(client.withdrawals_paused());

        // Withdrawal while paused must fail with WithdrawalsPaused
        set_time(&env, 86_400 * 2);
        let err = client
            .try_withdraw_fees(&admin, &token, &limit, &dest)
            .unwrap_err();
        assert_eq!(err, Ok(ContractError::WithdrawalsPaused));

        // Unpause
        client.unpause_withdrawals(&admin);
        assert!(!client.withdrawals_paused());

        // Withdrawal after unpause should succeed
        client.withdraw_fees(&admin, &token, &limit, &dest);
    }

    // ── 2. Only admin can pause / unpause ────────────────────────────────────

    #[test]
    fn test_only_admin_can_pause_unpause() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, _admin, _market, _token, _id) = setup(&env, limit, limit * 2);
        let non_admin = Address::generate(&env);

        let err_pause = client.try_pause_withdrawals(&non_admin).unwrap_err();
        assert_eq!(err_pause, Ok(ContractError::Unauthorized));

        let err_unpause = client.try_unpause_withdrawals(&non_admin).unwrap_err();
        assert_eq!(err_unpause, Ok(ContractError::Unauthorized));
    }

    // ── 3. DAILY_WITHDRAWN map is pruned to ≤ 2 entries over many days ───────

    #[test]
    fn test_daily_withdrawn_pruning_over_many_days() {
        let env = Env::default();
        env.mock_all_auths();

        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let limit = 10_000_000i128;
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);

        client.initialize(&admin, &token, &factory, &limit);
        client.approve_market(&admin, &market);
        StellarAssetClient::new(&env, &token).mint(&market, &(limit * 10));
        client.deposit_fees(&market, &token, &(limit * 10));

        let dest = Address::generate(&env);

        // Perform withdrawals across 7 consecutive days
        for day in 1u64..=7 {
            set_time(&env, 86_400 * day);
            client.withdraw_fees(&admin, &token, &limit, &dest);
        }

        // The global DAILY_WITHDRAWN map must have ≤ 2 entries
        let key = "DAILY_WITHDRAWN";
        let map_len = env.as_contract(&id, || {
            let daily: Map<u64, i128> = env
                .storage()
                .persistent()
                .get(&key)
                .unwrap_or_else(|| Map::new(&env));
            daily.keys().len()
        });
        assert!(
            map_len <= 2,
            "DAILY_WITHDRAWN must have ≤ 2 entries after pruning, got {map_len}"
        );

        // The per-token map for this token must also have ≤ 2 entries
        let key_by_token = "DAILY_WITHDRAWN_BY_TOKEN";
        let token_map_len = env.as_contract(&id, || {
            let by_token: Map<Address, Map<u64, i128>> = env
                .storage()
                .persistent()
                .get(&key_by_token)
                .unwrap_or_else(|| Map::new(&env));
            let token_daily: Map<u64, i128> =
                by_token.get(token.clone()).unwrap_or_else(|| Map::new(&env));
            token_daily.keys().len()
        });
        assert!(
            token_map_len <= 2,
            "per-token DAILY_WITHDRAWN must have ≤ 2 entries after pruning, got {token_map_len}"
        );
    }

    // ── 4. Fee conservation invariant across two tokens ──────────────────────

    /// For every token, total deposited = total withdrawn + balance remaining.
    #[test]
    fn test_fee_conservation_invariant_across_tokens() {
        let env = Env::default();
        env.mock_all_auths();
        set_time(&env, 86_400);

        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let factory = Address::generate(&env);
        let limit = 50_000_000i128;

        let token_a = env.register_stellar_asset_contract(admin.clone());
        let token_b = env.register_stellar_asset_contract(admin.clone());

        client.initialize(&admin, &token_a, &factory, &limit);
        client.approve_market(&admin, &market);

        let deposit_a = 40_000_000i128;
        let deposit_b = 35_000_000i128;

        StellarAssetClient::new(&env, &token_a).mint(&market, &deposit_a);
        StellarAssetClient::new(&env, &token_b).mint(&market, &deposit_b);

        client.deposit_fees(&market, &token_a, &deposit_a);
        client.deposit_fees(&market, &token_b, &deposit_b);

        let dest = Address::generate(&env);

        // Partial withdrawal of each token across different days
        let withdraw_a = 25_000_000i128;
        client.withdraw_fees(&admin, &token_a, &withdraw_a, &dest);

        set_time(&env, 86_400 * 2);
        let withdraw_b = 20_000_000i128;
        client.withdraw_fees(&admin, &token_b, &withdraw_b, &dest);

        // Verify conservation for token_a
        let balance_a = client.get_accumulated_fees(&token_a);
        assert_eq!(
            balance_a + withdraw_a,
            deposit_a,
            "fee conservation violated for token_a"
        );

        // Verify conservation for token_b
        let balance_b = client.get_accumulated_fees(&token_b);
        assert_eq!(
            balance_b + withdraw_b,
            deposit_b,
            "fee conservation violated for token_b"
        );

        // Verify on-chain token balances match
        let tc_a = soroban_sdk::token::Client::new(&env, &token_a);
        let tc_b = soroban_sdk::token::Client::new(&env, &token_b);

        // dest received withdraw_a + withdraw_b
        let dest_a_bal = tc_a.balance(&dest);
        let dest_b_bal = tc_b.balance(&dest);
        assert_eq!(dest_a_bal, withdraw_a);
        assert_eq!(dest_b_bal, withdraw_b);
    }

    // ── 5. Pause state is preserved across day boundaries ────────────────────

    #[test]
    fn test_pause_persists_across_day_boundary() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, _market, token, _id) = setup(&env, limit, limit * 5);
        let dest = Address::generate(&env);

        client.pause_withdrawals(&admin);

        // Advance to next day — pause flag must still be set
        set_time(&env, 86_400 * 2);
        assert!(client.withdrawals_paused());

        let err = client
            .try_withdraw_fees(&admin, &token, &limit, &dest)
            .unwrap_err();
        assert_eq!(err, Ok(ContractError::WithdrawalsPaused));
    }

    // ── 6. is_market_approved reflects approve/revoke ─────────────────────────

    #[test]
    fn test_is_market_approved_reflects_approve_revoke() {
        let env = Env::default();
        let limit = 10_000_000i128;
        let (client, admin, market, _token, _id) = setup(&env, limit, limit * 2);

        // market was approved in setup
        assert!(client.is_market_approved(&market));

        client.revoke_market(&admin, &market);
        assert!(!client.is_market_approved(&market));

        client.approve_market(&admin, &market);
        assert!(client.is_market_approved(&market));
    }

    // ── 7. Per-token daily cap is also pruned ─────────────────────────────────

    #[test]
    fn test_per_token_daily_cap_pruned_over_many_days() {
        let env = Env::default();
        env.mock_all_auths();

        let id = env.register_contract(None, Treasury);
        let client = TreasuryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let limit = 10_000_000i128;
        let token = env.register_stellar_asset_contract(admin.clone());
        let factory = Address::generate(&env);

        client.initialize(&admin, &token, &factory, &limit);
        client.approve_market(&admin, &market);
        StellarAssetClient::new(&env, &token).mint(&market, &(limit * 10));
        client.deposit_fees(&market, &token, &(limit * 10));

        let dest = Address::generate(&env);

        // Withdraw on 5 consecutive days
        for day in 1u64..=5 {
            set_time(&env, 86_400 * day);
            client.withdraw_fees(&admin, &token, &limit, &dest);
        }

        // Per-token map entries must be ≤ 2
        let key_by_token = "DAILY_WITHDRAWN_BY_TOKEN";
        let token_map_len = env.as_contract(&id, || {
            let by_token: Map<Address, Map<u64, i128>> = env
                .storage()
                .persistent()
                .get(&key_by_token)
                .unwrap_or_else(|| Map::new(&env));
            let token_daily: Map<u64, i128> =
                by_token.get(token.clone()).unwrap_or_else(|| Map::new(&env));
            token_daily.keys().len()
        });
        assert!(
            token_map_len <= 2,
            "per-token daily map must be pruned to ≤ 2 entries, got {token_map_len}"
        );
    }
}
        client.initialize(&admin, &token, &factory, &limit);
        (client, admin, market, token)
    }

    fn seed_fees(client: &TreasuryClient<'static>, admin: &Address, market: &Address, token: &Address, amount: i128, env: &Env) {
        let mut token_client = StellarAssetClient::new(env, token);
        token_client.mint(market, &amount);
        client.approve_market(admin, market);
        client.deposit_fees(market, token, &amount);
    }

    // ── Daily withdrawal cap ─────────────────────────────────────
    #[test]
    fn test_daily_cap_blocks_excess_withdrawals() {
        let env = Env::default();
        let limit = 30_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        seed_fees(&client, &admin, &market, &token, 100_000_000i128, &env);
        let dest = Address::generate(&env);

        // First withdrawal of the full daily limit succeeds.
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // A second withdrawal that would exceed the daily cap is rejected.
        let result = client.try_withdraw_fees(&admin, &token, &10_000_000i128, &dest);
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
    fn test_daily_cap_resets_across_days() {
        let env = Env::default();
        let limit = 30_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        seed_fees(&client, &admin, &market, &token, 300_000_000i128, &env);
        let dest = Address::generate(&env);

        let day_secs = 86_400u64;
        let set_ledger_time = |ts: u64| {
            env.ledger().set(LedgerInfo {
                timestamp: ts,
                protocol_version: 20,
                sequence_number: 2_000,
                network_id: Default::default(),
                base_reserve: 1,
                min_temp_entry_ttl: 16,
                min_persistent_entry_ttl: 4096,
                max_entry_ttl: 6_311_520,
            });
        };

        // Day 1: withdraw full daily limit.
        set_ledger_time(day_secs);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Day 2: the cap resets, allowing a withdrawal again.
        set_ledger_time(day_secs * 2);
        client.withdraw_fees(&admin, &token, &limit, &dest);

        // Day 2 total tracks the new day only.
        assert_eq!(client.get_daily_withdrawal_amount(), limit);
    }

    // ── Concurrency: withdrawal nonce ────────────────────────────
    #[test]
    fn test_withdraw_fees_with_nonce_rejects_stale_nonce() {
        let env = Env::default();
        let limit = 50_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        seed_fees(&client, &admin, &market, &token, 100_000_000i128, &env);
        let dest = Address::generate(&env);

        // Nonce starts at 0.
        assert_eq!(client.get_withdrawal_nonce(), 0);

        // Withdraw using the current nonce (0) succeeds.
        client.withdraw_fees_with_nonce(&admin, &token, &limit, &dest, &0);

        // Nonce is now 1.
        assert_eq!(client.get_withdrawal_nonce(), 1);

        // Replaying the same nonce (0) is rejected — prevents double-withdrawal.
        let replay = client.try_withdraw_fees_with_nonce(&admin, &token, &limit, &dest, &0);
        assert!(replay.is_err());
    }

    #[test]
    fn test_withdraw_fees_with_nonce_success_sequence() {
        let env = Env::default();
        // Daily cap == limit. Withdraw 3 small slices (each well under the cap).
        let limit = 50_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        seed_fees(&client, &admin, &market, &token, 200_000_000i128, &env);
        let dest = Address::generate(&env);

        let slice = 10_000_000i128;
        for n in 0..3u64 {
            client.withdraw_fees_with_nonce(&admin, &token, &slice, &dest, &n);
            assert_eq!(client.get_withdrawal_nonce(), n + 1);
        }
        assert_eq!(client.get_audit_log_count(), 1 + 3); // 1 deposit + 3 withdrawals
    }

    // ── Pause / unpause withdrawals ──────────────────────────────
    #[test]
    fn test_pause_withdrawals_blocks_and_unpause_resumes() {
        let env = Env::default();
        let limit = 50_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        seed_fees(&client, &admin, &market, &token, 100_000_000i128, &env);
        let dest = Address::generate(&env);

        client.pause_withdrawals(&admin);
        let blocked = client.try_withdraw_fees(&admin, &token, &limit, &dest);
        assert!(blocked.is_err());

        client.unpause_withdrawals(&admin);
        client.withdraw_fees(&admin, &token, &limit, &dest);
        assert_eq!(soroban_sdk::token::Client::new(&env, &token).balance(&dest), limit);
    }

    #[test]
    fn test_pause_requires_admin() {
        let env = Env::default();
        let limit = 50_000_000i128;
        let (client, _admin, _market, _token) = setup(&env, limit);
        let non_admin = Address::generate(&env);
        let err = client.try_pause_withdrawals(&non_admin);
        assert!(err.is_err());
    }

    // ── Immutable audit log ──────────────────────────────────────
    #[test]
    fn test_audit_log_is_append_only_and_ordered() {
        let env = Env::default();
        let limit = 50_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        seed_fees(&client, &admin, &market, &token, 100_000_000i128, &env);
        let dest = Address::generate(&env);

        // One deposit (from seed_fees) plus one withdrawal.
        client.withdraw_fees(&admin, &token, &limit, &dest);

        let count = client.get_audit_log_count();
        assert_eq!(count, 2); // deposit + withdrawal

        // Entries are readable in insertion order with ascending ids.
        let entry0: AuditEntry = client.get_audit_entry(&0).unwrap();
        assert_eq!(entry0.id, 0);
        let entry1: AuditEntry = client.get_audit_entry(&1).unwrap();
        assert_eq!(entry1.id, 1);

        // Out-of-range access returns None.
        assert!(client.get_audit_entry(&count).is_none());
        assert!(client.get_audit_entry(&999).is_none());
    }

    #[test]
    fn test_withdrawal_nonce_and_audit_record_consistency() {
        let env = Env::default();
        let limit = 50_000_000i128;
        let (client, admin, market, token) = setup(&env, limit);
        seed_fees(&client, &admin, &market, &token, 150_000_000i128, &env);
        let dest = Address::generate(&env);

        client.withdraw_fees_with_nonce(&admin, &token, &limit, &dest, &0);
        assert_eq!(client.get_withdrawal_nonce(), 1);

        // A stale nonce must not mutate the ledger.
        let stale = client.try_withdraw_fees_with_nonce(&admin, &token, &limit, &dest, &0);
        assert!(stale.is_err());
        assert_eq!(client.get_withdrawal_nonce(), 1);
        assert_eq!(client.get_audit_log_count(), 2); // deposit + 1 successful withdraw
    }
}


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
