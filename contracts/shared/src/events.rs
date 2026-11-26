//! ============================================================
//! BANKERCHANGER — Contract Events
//! All emitted events are defined here for consistency.
//! ============================================================

use soroban_sdk::{contracttype, Address, Env, String, Symbol};

use crate::types::{AuditEntry, BetPlacedPayload, BetRecord, ClaimReceipt, OddsSnapshot, Outcome};

// ─── Centralized Topic Symbols ───────────────────────────────────────────────
// All event topic names are defined here to guarantee consistency and avoid
// typos or divergent topic strings across emission helpers.

/// Topic symbol for `market_created` events.
pub const TOPIC_MARKET_CREATED: &str = "market_created";
/// Topic symbol for `market_locked` events.
pub const TOPIC_MARKET_LOCKED: &str = "market_locked";
/// Topic symbol for `market_resolved` events.
pub const TOPIC_MARKET_RESOLVED: &str = "market_resolved";
/// Topic symbol for `bet_placed` events.
pub const TOPIC_BET_PLACED: &str = "bet_placed";

// ─── Typed Event Data ────────────────────────────────────────────────────────

/// Data payload for the `market_created` event.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MarketCreatedEvent {
    pub contract_address: Address,
    pub match_id: String,
}

/// Data payload for the `bet_placed` event.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BetPlacedEvent {
    pub bet: BetRecord,
    pub odds_at_bet_time: OddsSnapshot,
}

/// Data payload for the `market_resolved` event.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MarketResolvedEvent {
    pub outcome: Outcome,
    pub oracle_address: Address,
}

/// Emits a `market_created` event when a new market is deployed.
///
/// Topics: `(Symbol("market_created"), market_id)`
/// Data:   `MarketCreatedEvent { contract_address, match_id }`
pub fn emit_market_created(env: &Env, market_id: u64, contract_address: Address, match_id: String) {
    let topics = (Symbol::new(env, TOPIC_MARKET_CREATED), market_id);
    env.events().publish(
        topics,
        MarketCreatedEvent {
            contract_address,
            match_id,
        },
    );
}

/// Emits a `market_locked` event when betting is closed.
///
/// Topics: `(Symbol("market_locked"), market_id)`
/// Data:   `()`
pub fn emit_market_locked(env: &Env, market_id: u64) {
    let topics = (Symbol::new(env, TOPIC_MARKET_LOCKED), market_id);
    env.events().publish(topics, ());
}

/// Emits a `market_resolved` event when an oracle submits a final outcome.
///
/// Topics: `(Symbol("market_resolved"), market_id)`
/// Data:   `MarketResolvedEvent { outcome, oracle_address }`
pub fn emit_market_resolved(env: &Env, market_id: u64, outcome: Outcome, oracle_address: Address) {
    let topics = (Symbol::new(env, TOPIC_MARKET_RESOLVED), market_id);
    env.events().publish(
        topics,
        MarketResolvedEvent {
            outcome,
            oracle_address,
        },
    );
}

/// Emits a `market_resolution_pending` event when oracle consensus is reached
/// but the dispute cooldown window is still active.
///
/// Topics: `(Symbol("market_resolution_pending"), market_id)`
/// Data:   `(outcome_byte: u8, cooldown_end_ledger: u32)`
pub fn emit_market_resolution_pending(
    env: &Env,
    market_id: u64,
    outcome_byte: u32,
    cooldown_end_ledger: u32,
) {
    let topics = (Symbol::new(env, "market_resolution_pending"), market_id);
    env.events().publish(topics, (outcome_byte, cooldown_end_ledger));
}

/// Emits a `resolution_finalized` event when anyone successfully calls
/// `finalize_resolution` after the cooldown window has elapsed.
///
/// Topics: `(Symbol("resolution_finalized"), market_id)`
/// Data:   `(outcome_byte: u32)`
pub fn emit_resolution_finalized(env: &Env, market_id: u64, outcome_byte: u32) {
    let topics = (Symbol::new(env, "resolution_finalized"), market_id);
    env.events().publish(topics, outcome_byte);
}

/// Emits a `bet_placed` event.
///
/// This is the single canonical emission path for `bet_placed` events. It
/// publishes a [`BetPlacedEvent`] carrying the bet record and the odds snapshot
/// captured at bet time.
///
/// Topics: `(Symbol("bet_placed"), market_id)`
/// Data:   `BetPlacedEvent { bet, odds_at_bet_time }`
pub fn emit_bet_placed(
    env: &Env,
    market_id: u64,
    bet: BetRecord,
    odds_at_bet_time: OddsSnapshot,
) {
    let topics = (Symbol::new(env, TOPIC_BET_PLACED), market_id);
    env.events().publish(
        topics,
        BetPlacedEvent {
            bet,
            odds_at_bet_time,
        },
    );
}

/// Emits a `winnings_claimed` event when a winner claims their payout.
///
/// Topics: `(Symbol("winnings_claimed"), market_id)`
/// Data:   `ClaimReceipt`
pub fn emit_winnings_claimed(env: &Env, market_id: u64, receipt: ClaimReceipt) {
    let topics = (Symbol::new(env, "winnings_claimed"), market_id);
    env.events().publish(topics, receipt);
}

/// Emits a `refund_claimed` event when a bettor claims a refund on a cancelled market.
///
/// Topics: `(Symbol("refund_claimed"), market_id)`
/// Data:   `(bettor, amount)`
pub fn emit_refund_claimed(env: &Env, market_id: u64, bettor: Address, amount: i128) {
    let topics = (Symbol::new(env, "refund_claimed"), market_id);
    env.events().publish(topics, (bettor, amount));
}

/// Event payload for market cancellation.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MarketCancelled {
    pub market_id: u64,
    pub cancelled_by: Address,
    pub reason: String,
    pub cancelled_at: u64,
}

/// Emits a `market_cancelled` event when a market is cancelled.
///
/// Topics: `(Symbol("market_cancelled"), market_id)`
/// Data:   `(cancelled_by: Address, reason: String, cancelled_at: u64)`
pub fn emit_market_cancelled(
    env: &Env,
    market_id: u64,
    cancelled_by: Address,
    reason: String,
    cancelled_at: u64,
) {
    let topics = (Symbol::new(env, "market_cancelled"), market_id);
    env.events().publish(topics, (cancelled_by, reason, cancelled_at));
}

/// Emits a `market_paused` event when a specific market is paused.
///
/// Topics: `(Symbol("market_paused"), market_id)`
/// Data:   `admin: Address`
pub fn emit_market_paused(env: &Env, market_id: u64, admin: Address) {
    let topics = (Symbol::new(env, "market_paused"), market_id);
    env.events().publish(topics, admin);
}

/// Emits a `market_unpaused` event when a specific market is unpaused.
///
/// Topics: `(Symbol("market_unpaused"), market_id)`
/// Data:   `admin: Address`
pub fn emit_market_unpaused(env: &Env, market_id: u64, admin: Address) {
    let topics = (Symbol::new(env, "market_unpaused"), market_id);
    env.events().publish(topics, admin);
}

/// Emits a `market_expired_refund` event when an expired market's bets are refunded.
///
/// Topics: `(Symbol("market_expired_refund"), market_id)`
/// Data:   `(bettor, amount)`
pub fn emit_market_expired_refund(env: &Env, market_id: u64, bettor: Address, amount: i128) {
    let topics = (Symbol::new(env, "market_expired_refund"), market_id);
    env.events().publish(topics, (bettor, amount));
}

/// Emits the aggregate amount refunded after an expired market is cancelled.
pub fn emit_market_expired_refunded(env: &Env, market_id: u64, total_refunded: i128) {
    let topics = (Symbol::new(env, "market_expired_refunded"), market_id);
    env.events().publish(topics, total_refunded);
}

/// Emits a `market_disputed` event when a resolved market is placed under review.
///
/// Topics: `(Symbol("market_disputed"), market_id)`
/// Data:   `reason: String`
pub fn emit_market_disputed(env: &Env, market_id: u64, reason: String) {
    let topics = (Symbol::new(env, "market_disputed"), market_id);
    env.events().publish(topics, reason);
}

/// Emits a `dispute_resolved` event when an admin finalises a disputed outcome.
///
/// Topics: `(Symbol("dispute_resolved"), market_id)`
/// Data:   `final_outcome: Outcome`
pub fn emit_dispute_resolved(env: &Env, market_id: u64, final_outcome: Outcome) {
    let topics = (Symbol::new(env, "dispute_resolved"), market_id);
    env.events().publish(topics, final_outcome);
}

/// Emits an `admin_proposed` event when the current admin nominates a successor.
/// The transfer is not final until the nominee calls `accept_admin`.
///
/// Topics: `(Symbol("admin_proposed"),)`
/// Data:   `(current_admin, proposed_admin)`
pub fn emit_admin_proposed(env: &Env, current_admin: Address, proposed_admin: Address) {
    let topics = (Symbol::new(env, "admin_proposed"),);
    env.events()
        .publish(topics, (current_admin, proposed_admin));
}

/// Emits an `admin_transferred` event when admin privileges change hands.
///
/// Topics: `(Symbol("admin_transferred"),)`
/// Data:   `(old_admin, new_admin)`
pub fn emit_admin_transferred(env: &Env, old_admin: Address, new_admin: Address) {
    let topics = (Symbol::new(env, "admin_transferred"),);
    env.events().publish(topics, (old_admin, new_admin));
}

/// Emits the previous and new admin timelock values.
pub fn emit_admin_timelock_updated(env: &Env, old_timelock: u64, new_timelock: u64) {
    env.events().publish(
        (Symbol::new(env, "admin_timelock_updated"),),
        (old_timelock, new_timelock),
    );
}

/// Emits a proposed admin transfer together with its unlock time.
pub fn emit_admin_transfer_proposed(
    env: &Env,
    current_admin: Address,
    pending_admin: Address,
    unlock_time: u64,
) {
    env.events().publish(
        (Symbol::new(env, "admin_transfer_proposed"),),
        (current_admin, pending_admin, unlock_time),
    );
}

/// Emits the completed admin transfer.
pub fn emit_admin_transfer_accepted(env: &Env, old_admin: Address, new_admin: Address) {
    env.events().publish(
        (Symbol::new(env, "admin_transfer_accepted"),),
        (old_admin, new_admin),
    );
}

/// Emits a `fee_deposited` event when a market deposits fees into the treasury.
///
/// Topics: `(Symbol("fee_deposited"),)`
/// Data:   `(market, token, amount)`
pub fn emit_fee_deposited(env: &Env, market: Address, token: Address, amount: i128) {
    let topics = (Symbol::new(env, "fee_deposited"),);
    env.events().publish(topics, (market, token, amount));
}

/// Emits a `fee_withdrawn` event when the admin withdraws accumulated fees.
///
/// Topics: `(Symbol("fee_withdrawn"),)`
/// Data:   `(token, amount, destination)`
pub fn emit_fee_withdrawn(env: &Env, token: Address, amount: i128, destination: Address) {
    let topics = (Symbol::new(env, "fee_withdrawn"),);
    env.events().publish(topics, (token, amount, destination));
}

/// Emits an `emergency_drain` event when the admin drains all fees for a token.
///
/// Topics: `(Symbol("emergency_drain"),)`
/// Data:   `(token, amount, admin)`
pub fn emit_emergency_drain(env: &Env, token: Address, amount: i128, admin: Address) {
    let topics = (Symbol::new(env, "emergency_drain"),);
    env.events().publish(topics, (token, amount, admin));
}

/// Emits an `audit_recorded` event whenever an immutable audit entry is
/// appended to the treasury ledger.
///
/// Topics: `(Symbol("audit_recorded"),)`
/// Data:   `AuditEntry`
pub fn emit_audit_recorded(env: &Env, entry: AuditEntry) {
    let topics = (Symbol::new(env, "audit_recorded"),);
    env.events().publish(topics, entry);
}

/// Emits a `config_updated` event when a configuration parameter is changed.
///
/// Topics: `(Symbol("config_updated"),)`
/// Data:   `(param_name, new_value)`
pub fn emit_config_updated(env: &Env, param_name: String, new_value: i128) {
    let topics = (Symbol::new(env, "config_updated"),);
    env.events().publish(topics, (param_name, new_value));
}

/// Emits a `conflicting_oracle_report` event when two oracles disagree on the outcome.
///
/// Topics: `(Symbol("conflicting_oracle_report"), market_id)`
/// Data:   `oracle_address`
pub fn emit_conflicting_oracle_report(env: &Env, market_id: u64, oracle_address: Address) {
    let topics = (Symbol::new(env, "conflicting_oracle_report"), market_id);
    env.events().publish(topics, oracle_address);
}

pub fn emit_contract_upgraded(env: &Env, new_wasm_hash: soroban_sdk::BytesN<32>) {
    let topics = (Symbol::new(env, "contract_upgraded"),);
    env.events().publish(topics, new_wasm_hash);
}

/// Emits a `withdrawals_paused` event when the admin pauses all withdrawals.
///
/// Topics: `(Symbol("withdrawals_paused"),)`
/// Data:   `admin: Address`
pub fn emit_withdrawals_paused(env: &Env, admin: Address) {
    let topics = (Symbol::new(env, "withdrawals_paused"),);
    env.events().publish(topics, admin);
}

/// Emits a `withdrawals_unpaused` event when the admin resumes withdrawals.
///
/// Topics: `(Symbol("withdrawals_unpaused"),)`
/// Data:   `admin: Address`
pub fn emit_withdrawals_unpaused(env: &Env, admin: Address) {
    let topics = (Symbol::new(env, "withdrawals_unpaused"),);
    env.events().publish(topics, admin);
}

/// Emits an `audit_entry` event for every write to the immutable audit log.
///
/// Topics: `(Symbol("audit_entry"),)`
/// Data:   `(action, actor, token, amount, timestamp)`
pub fn emit_audit_entry(
    env: &Env,
    action: Symbol,
    actor: Address,
    token: Address,
    amount: i128,
    timestamp: u64,
) {
    let topics = (Symbol::new(env, "audit_entry"),);
    env.events().publish(topics, (action, actor, token, amount, timestamp));
}

/// Emits a `stale_reports_cleared` event when the admin removes expired pending
/// oracle reports so a fresh resolution cycle can begin.
///
/// Topics: `(Symbol("stale_reports_cleared"), market_id)`
/// Data:   `cleared_count: u32`
pub fn emit_stale_reports_cleared(env: &Env, market_id: u64, cleared_count: u32) {
    let topics = (Symbol::new(env, "stale_reports_cleared"), market_id);
    env.events().publish(topics, cleared_count);
}

/// Emits an `audit_log_entry` event each time fees are successfully withdrawn.
/// This event forms the basis of the immutable off-chain audit trail; every
/// withdrawal that passes all guards is guaranteed to produce exactly one entry.
///
/// Topics: `(Symbol("audit_log_entry"), seq)`
/// Data:   `AuditEntry`
pub fn emit_audit_log_entry(env: &Env, entry: AuditEntry) {
    let id = entry.id;
    let topics = (Symbol::new(env, "audit_log_entry"), id);
    env.events().publish(topics, entry);
}

// ─── AMM & Odds Calculation Pipeline — Tier Events ───────────────────────────
// The following events support issues #473 (tier 8), #474 (tier 10),
// #475 (tier 12), and #476 (tier 14).

/// Emits an `odds_updated` event after each bet that changes the pool ratios.
///
/// Subscribing frontends use this event to refresh live displayed odds without
/// polling the contract state.
///
/// Topics: `(Symbol("odds_updated"), market_id)`
/// Data:   `(tier, pool_a, pool_b, pool_draw, impact_bps)`
///
/// * `tier`       — Market tier byte (8 / 10 / 12 / 14; 0 = no tier)
/// * `pool_a`     — New pool size for FighterA in stroops
/// * `pool_b`     — New pool size for FighterB in stroops
/// * `pool_draw`  — New pool size for Draw in stroops
/// * `impact_bps` — Price impact of the triggering bet in basis points
pub fn emit_odds_updated(
    env: &Env,
    market_id: u64,
    tier: u32,
    pool_a: i128,
    pool_b: i128,
    pool_draw: i128,
    impact_bps: i128,
) {
    let topics = (Symbol::new(env, "odds_updated"), market_id);
    env.events().publish(topics, (tier, pool_a, pool_b, pool_draw, impact_bps));
}

/// Emits a `slippage_checked` event when a bet passes the AMM slippage guard.
///
/// Provides an audit trail for every bet that was evaluated against the
/// tier-specific slippage tolerance.  Only emitted when the check succeeds;
/// failed bets are rejected before reaching the event layer.
///
/// Topics: `(Symbol("slippage_checked"), market_id)`
/// Data:   `(tier, shares_out, impact_bps, max_slippage_bps)`
pub fn emit_slippage_checked(
    env: &Env,
    market_id: u64,
    tier: u32,
    shares_out: i128,
    impact_bps: i128,
    max_slippage_bps: i128,
) {
    let topics = (Symbol::new(env, "slippage_checked"), market_id);
    env.events().publish(topics, (tier, shares_out, impact_bps, max_slippage_bps));
}

/// Emits an `oracle_report_received` event when a valid oracle report is stored
/// during 2-of-3 consensus accumulation.
///
/// Allows frontends to display live resolution progress (e.g. "1 / 2 oracles
/// confirmed") without polling PENDING_REPORTS storage.
///
/// Topics: `(Symbol("oracle_report_received"), market_id)`
/// Data:   `(oracle_address, outcome_byte, report_count)`
///
/// * `oracle_address` — The reporting oracle's Stellar address
/// * `outcome_byte`   — 0 = FighterA, 1 = FighterB, 2 = Draw, 3 = NoContest
/// * `report_count`   — Total reports received so far (including this one)
pub fn emit_oracle_report_received(
    env: &Env,
    market_id: u64,
    oracle_address: Address,
    outcome_byte: u32,
    report_count: u32,
) {
    let topics = (Symbol::new(env, "oracle_report_received"), market_id);
    env.events().publish(topics, (oracle_address, outcome_byte, report_count));
}

/// Emits a `consensus_reached` event when 2-of-3 oracle reports agree and the
/// market transitions to `Resolved`.
///
/// Distinct from `market_resolved` — this event carries the consensus details
/// (report count and tier) that frontends need for resolution UX.
///
/// Topics: `(Symbol("consensus_reached"), market_id)`
/// Data:   `(tier, matching_reports, outcome_byte)`
pub fn emit_consensus_reached(
    env: &Env,
    market_id: u64,
    tier: u32,
    matching_reports: u32,
    outcome_byte: u32,
) {
    let topics = (Symbol::new(env, "consensus_reached"), market_id);
    env.events().publish(topics, (tier, matching_reports, outcome_byte));
}

/// Emits a `pool_initialized` event when a market's liquidity pools are first
/// seeded with funds, unlocking the AMM slippage checks for that market.
///
/// Topics: `(Symbol("pool_initialized"), market_id)`
/// Data:   `(tier, pool_a, pool_b, pool_draw)`
pub fn emit_pool_initialized(
    env: &Env,
    market_id: u64,
    tier: u32,
    pool_a: i128,
    pool_b: i128,
    pool_draw: i128,
) {
    let topics = (Symbol::new(env, "pool_initialized"), market_id);
    env.events().publish(topics, (tier, pool_a, pool_b, pool_draw));
}

/// Emits a `withdrawal_limit_updated` event when the admin updates the daily withdrawal limit.
///
/// Topics: `(Symbol("withdrawal_limit_updated"),)`
/// Data:   `(old_limit, new_limit)`
pub fn emit_withdrawal_limit_updated(env: &Env, old_limit: i128, new_limit: i128) {
    let topics = (Symbol::new(env, "withdrawal_limit_updated"),);
    env.events().publish(topics, (old_limit, new_limit));
}

/// Emits a `withdrawal_audit_log` event on every successful fee withdrawal.
/// This provides an immutable on-chain audit trail of all fund movements.
///
/// Topics: `(Symbol("withdrawal_audit_log"),)`
/// Data:   `AuditEntry`
pub fn emit_withdrawal_audit_log(env: &Env, entry: crate::types::AuditEntry) {
    let topics = (Symbol::new(env, "withdrawal_audit_log"),);
    env.events().publish(topics, entry);
}

/// Emits a `liquidity_added` event when an LP provides liquidity to a market pool.
///
/// Topics: `(Symbol("liquidity_added"), market_id)`
/// Data:   `(provider, amount_a, amount_b, amount_draw, lp_shares)`
pub fn emit_liquidity_added(
    env: &Env,
    market_id: u64,
    provider: Address,
    amount_a: i128,
    amount_b: i128,
    amount_draw: i128,
    lp_shares: i128,
) {
    let topics = (Symbol::new(env, "liquidity_added"), market_id);
    env.events().publish(topics, (provider, amount_a, amount_b, amount_draw, lp_shares));
}

/// Emits a `liquidity_removed` event when an LP redeems shares from a market pool.
///
/// Topics: `(Symbol("liquidity_removed"), market_id)`
/// Data:   `(provider, lp_shares_burned, amount_a, amount_b, amount_draw, fees_claimed)`
#[allow(clippy::too_many_arguments)]
pub fn emit_liquidity_removed(
    env: &Env,
    market_id: u64,
    provider: Address,
    lp_shares_burned: i128,
    amount_a: i128,
    amount_b: i128,
    amount_draw: i128,
    fees_claimed: i128,
) {
    let topics = (Symbol::new(env, "liquidity_removed"), market_id);
    env.events().publish(topics, (provider, lp_shares_burned, amount_a, amount_b, amount_draw, fees_claimed));
}

/// Emits an `oracle_report_submitted` event when an oracle submits a resolution report.
/// Provides real-time frontend visibility into the 2-of-3 consensus progress.
///
/// Topics: `(Symbol("oracle_report_submitted"), market_id)`
/// Data:   `(oracle_address, outcome_index, matching_count)`
/// Note: outcome_index is u32 for Soroban Val compatibility (0=FighterA, 1=FighterB, 2=Draw, 3=NoContest)
pub fn emit_oracle_report_submitted(
    env: &Env,
    market_id: u64,
    oracle_address: Address,
    outcome_index: u32,
    matching_count: u32,
) {
    let topics = (Symbol::new(env, "oracle_report_submitted"), market_id);
    env.events().publish(topics, (oracle_address, outcome_index, matching_count));
}

/// Emits an `odds_computed` event after a bet is placed, broadcasting current pool
/// state and odds for real-time frontend updates.
///
/// Topics: `(Symbol("odds_computed"), market_id)`
/// Data:   `(pool_a, pool_b, pool_draw, shares_out, price_impact_bps)`
pub fn emit_odds_computed(
    env: &Env,
    market_id: u64,
    pool_a: i128,
    pool_b: i128,
    pool_draw: i128,
    shares_out: i128,
    price_impact_bps: i128,
) {
    let topics = (Symbol::new(env, "odds_computed"), market_id);
    env.events().publish(topics, (pool_a, pool_b, pool_draw, shares_out, price_impact_bps));
}


/// Emits an `audit_log` event for every treasury action that alters balances.
///
/// Topics: `(Symbol("audit_log"), day_bucket)`
/// Data:   `(action_name: &str, token, amount, actor, timestamp)`
///
/// The `action_name` is a short ASCII string matching the `AuditAction` variant
/// name, kept as a `Symbol` so downstream indexers can filter cheaply by topic.
pub fn emit_audit_log(
    env: &Env,
    action: soroban_sdk::Symbol,
    token: Address,
    amount: i128,
    actor: Address,
    timestamp: u64,
    day_bucket: u64,
) {
    let topics = (Symbol::new(env, "audit_log"), day_bucket);
    env.events().publish(topics, (action, token, amount, actor, timestamp));
}

/// Emits a `daily_cap_reached` event when a withdrawal hits the daily ceiling.
///
/// Topics: `(Symbol("daily_cap_reached"), day_bucket)`
/// Data:   `(token, total_withdrawn_today, cap)`
pub fn emit_daily_cap_reached(
    env: &Env,
    token: Address,
    total_withdrawn_today: i128,
    cap: i128,
    day_bucket: u64,
) {
    let topics = (Symbol::new(env, "daily_cap_reached"), day_bucket);
    env.events().publish(topics, (token, total_withdrawn_today, cap));
}

/// Emits a `fee_tiers_updated` event when the admin updates treasury fee tiers.
///
/// Topics: `(Symbol("fee_tiers_updated"),)`
/// Data:   `(admin, tier_count)`
pub fn emit_fee_tiers_updated(env: &Env, admin: Address, tier_count: u32) {
    let topics = (Symbol::new(env, "fee_tiers_updated"),);
    env.events().publish(topics, (admin, tier_count));
}

#[cfg(test)]
mod tests {
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Events},
        Address, Env,
    };

    use crate::{
        events::*,
        types::{BetRecord, BetSide, ClaimReceipt, OddsSnapshot, Outcome},
    };

    #[contract]
    struct Dummy;

    #[contractimpl]
    impl Dummy {}

    fn env() -> (Env, Address) {
        let env = Env::default();
        let id = env.register(Dummy, ());
        (env, id)
    }

    fn addr(env: &Env) -> Address {
        Address::generate(env)
    }

    fn str(env: &Env, s: &str) -> soroban_sdk::String {
        soroban_sdk::String::from_str(env, s)
    }

    macro_rules! sole_event {
        ($env:expr, $contract:expr) => {{
            // soroban-sdk 22.x: Events::all() returns Vec<(Address, Vec<Val>, Val)>.
            // Filter by matching the contract address in the first tuple element.
            let all = $env.events().all();
            let count = all
                .iter()
                .filter(|(addr, _, _)| addr == $contract)
                .count();
            assert_eq!(count, 1, "expected exactly 1 event from contract");
        }};
    }

    #[test]
    fn test_emit_market_created() {
        let (env, id) = env();
        let contract = addr(&env);
        env.as_contract(&id, || {
            emit_market_created(&env, 1, contract.clone(), str(&env, "FURY-USYK-2025"));
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_market_created_topic_and_payload() {
        use soroban_sdk::{FromVal, IntoVal, Symbol, Val, Vec};

        let (env, id) = env();
        let contract = addr(&env);
        let match_id = str(&env, "FURY-USYK-2025");
        env.as_contract(&id, || {
            emit_market_created(&env, 42, contract.clone(), match_id.clone());
        });

        let all = env.events().all();
        let (emitter, topics, data) = all
            .iter()
            .find(|(addr, _, _)| addr == &id)
            .expect("market_created event not emitted");

        assert_eq!(emitter, id);
        assert_eq!(topics.len(), 2);
        let topic0 = Symbol::from_val(&env, &topics.get(0).unwrap());
        assert_eq!(topic0, Symbol::new(&env, TOPIC_MARKET_CREATED));
        let topic1 = u64::from_val(&env, &topics.get(1).unwrap());
        assert_eq!(topic1, 42);

        let payload = MarketCreatedEvent::from_val(&env, &data);
        assert_eq!(payload.contract_address, contract);
        assert_eq!(payload.match_id, match_id);

        // Ensure no duplicate emission paths produced extra events.
        let count = all.iter().filter(|(addr, _, _)| addr == &id).count();
        assert_eq!(count, 1, "expected exactly one market_created event");
        let _ = (Vec::<Val>::new(&env),);
    }

    #[test]
    fn test_emit_market_locked() {
        let (env, id) = env();
        env.as_contract(&id, || {
            emit_market_locked(&env, 2);
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_market_resolved() {
        let (env, id) = env();
        let oracle = addr(&env);
        env.as_contract(&id, || {
            emit_market_resolved(&env, 3, Outcome::FighterA, oracle.clone());
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_market_resolved_topic_and_payload() {
        use soroban_sdk::{FromVal, Symbol};

        let (env, id) = env();
        let oracle = addr(&env);
        env.as_contract(&id, || {
            emit_market_resolved(&env, 77, Outcome::FighterB, oracle.clone());
        });

        let all = env.events().all();
        let (_, topics, data) = all
            .iter()
            .find(|(addr, _, _)| addr == &id)
            .expect("market_resolved event not emitted");

        assert_eq!(topics.len(), 2);
        let topic0 = Symbol::from_val(&env, &topics.get(0).unwrap());
        assert_eq!(topic0, Symbol::new(&env, TOPIC_MARKET_RESOLVED));
        let topic1 = u64::from_val(&env, &topics.get(1).unwrap());
        assert_eq!(topic1, 77);

        let payload = MarketResolvedEvent::from_val(&env, &data);
        assert_eq!(payload.outcome, Outcome::FighterB);
        assert_eq!(payload.oracle_address, oracle);

        let count = all.iter().filter(|(addr, _, _)| addr == &id).count();
        assert_eq!(count, 1, "expected exactly one market_resolved event");
    }

    #[test]
    fn test_emit_bet_placed() {
        let (env, id) = env();
        let bettor = addr(&env);
        let bet = BetRecord {
            bettor: bettor.clone(),
            market_id: 4,
            side: BetSide::FighterA,
            amount: 5_000_000,
            placed_at: 1_000_000,
            claimed: false,
        };
        let odds = OddsSnapshot {
            pool_a: 10_000_000,
            pool_b: 10_000_000,
            pool_draw: 10_000_000,
            odds_a_bps: 3_333,
            odds_b_bps: 3_333,
            odds_draw_bps: 3_334,
            captured_at: 1_000_000,
        };
        env.as_contract(&id, || {
            emit_bet_placed(&env, 4, bet.clone(), odds.clone());
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_bet_placed_topic_and_payload() {
        use soroban_sdk::{FromVal, Symbol};

        let (env, id) = env();
        let bettor = addr(&env);
        let bet = BetRecord {
            bettor: bettor.clone(),
            market_id: 55,
            side: BetSide::Draw,
            amount: 2_500_000,
            placed_at: 1_234_567,
            claimed: false,
        };
        let odds = OddsSnapshot {
            pool_a: 5_000_000,
            pool_b: 6_000_000,
            pool_draw: 7_000_000,
            odds_a_bps: 4_000,
            odds_b_bps: 3_500,
            odds_draw_bps: 2_500,
            captured_at: 1_234_567,
        };
        env.as_contract(&id, || {
            emit_bet_placed(&env, 55, bet.clone(), odds.clone());
        });

        let all = env.events().all();
        let (_, topics, data) = all
            .iter()
            .find(|(addr, _, _)| addr == &id)
            .expect("bet_placed event not emitted");

        assert_eq!(topics.len(), 2);
        let topic0 = Symbol::from_val(&env, &topics.get(0).unwrap());
        assert_eq!(topic0, Symbol::new(&env, TOPIC_BET_PLACED));
        let topic1 = u64::from_val(&env, &topics.get(1).unwrap());
        assert_eq!(topic1, 55);

        let payload = BetPlacedEvent::from_val(&env, &data);
        assert_eq!(payload.bet, bet);
        assert_eq!(payload.odds_at_bet_time, odds);

        let count = all.iter().filter(|(addr, _, _)| addr == &id).count();
        assert_eq!(count, 1, "expected exactly one bet_placed event");
    }

    #[test]
    fn test_emit_winnings_claimed() {
        let (env, id) = env();
        let bettor = addr(&env);
        let receipt = ClaimReceipt {
            bettor: bettor.clone(),
            market_id: 5,
            amount_won: 9_800_000,
            fee_deducted: 200_000,
            claimed_at: 2_000_000,
        };
        env.as_contract(&id, || {
            emit_winnings_claimed(&env, 5, receipt);
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_refund_claimed() {
        let (env, id) = env();
        let bettor = addr(&env);
        env.as_contract(&id, || {
            emit_refund_claimed(&env, 6, bettor.clone(), 5_000_000);
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_market_cancelled() {
        let (env, id) = env();
        let cancelled_by = addr(&env);
        env.as_contract(&id, || {
            emit_market_cancelled(
                &env,
                7,
                cancelled_by,
                str(&env, "fight_postponed"),
                1234,
            );
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_market_disputed() {
        let (env, id) = env();
        env.as_contract(&id, || {
            emit_market_disputed(&env, 8, str(&env, "oracle_conflict"));
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_dispute_resolved() {
        let (env, id) = env();
        env.as_contract(&id, || {
            emit_dispute_resolved(&env, 9, Outcome::Draw);
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_admin_transferred() {
        let (env, id) = env();
        let old = addr(&env);
        let new = addr(&env);
        env.as_contract(&id, || {
            emit_admin_transferred(&env, old.clone(), new.clone());
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_fee_deposited() {
        let (env, id) = env();
        let market = addr(&env);
        let token = addr(&env);
        env.as_contract(&id, || {
            emit_fee_deposited(&env, market.clone(), token.clone(), 200_000);
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_fee_withdrawn() {
        let (env, id) = env();
        let token = addr(&env);
        let dest = addr(&env);
        env.as_contract(&id, || {
            emit_fee_withdrawn(&env, token.clone(), 1_000_000, dest.clone());
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_emergency_drain() {
        let (env, id) = env();
        let token = addr(&env);
        let admin = addr(&env);
        env.as_contract(&id, || {
            emit_emergency_drain(&env, token.clone(), 50_000_000, admin.clone());
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_config_updated() {
        let (env, id) = env();
        env.as_contract(&id, || {
            emit_config_updated(&env, str(&env, "fee_bps"), 300);
        });

        sole_event!(env, &id);
    }

    #[test]
    fn test_emit_conflicting_oracle_report() {
        let (env, id) = env();
        let oracle = addr(&env);
        env.as_contract(&id, || {
            emit_conflicting_oracle_report(&env, 10, oracle.clone());
        });

        sole_event!(env, &id);
    }
}
