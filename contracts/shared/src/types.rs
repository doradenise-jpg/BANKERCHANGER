//! ============================================================
//! BANKERCHANGER — Shared Types
//! All contracts import from this crate.
//! Contributors: DO NOT add logic here — types and structs only.
//! ============================================================

use soroban_sdk::{contracttype, Address, BytesN, String};

// ─── Enums ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum MarketStatus {
    Open,      // Bets are being accepted
    Locked,    // Fight has started; bets are closed
    Resolved,  // Winner declared; claims are open
    Cancelled, // Fight cancelled; full refunds available
    Disputed,  // Outcome under admin review; claims frozen
}

/// Market tier classification for the AMM & Odds Calculation Pipeline.
///
/// Each tier defines different liquidity pool requirements and slippage
/// tolerance thresholds suited to the expected bet volume and market depth.
///
/// | Tier | Min Liquidity (XLM) | Max Slippage (bps) | Description           |
/// |------|---------------------|--------------------|-----------------------|
/// | 8    | 80 XLM              | 3 000 bps (30 %)   | Entry-level market    |
/// | 10   | 100 XLM             | 2 500 bps (25 %)   | Standard market       |
/// | 12   | 120 XLM             | 2 000 bps (20 %)   | Established market    |
/// | 14   | 140 XLM             | 1 500 bps (15 %)   | High-volume market    |
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum MarketTier {
    /// Tier 8 — entry-level markets with 80 XLM minimum liquidity.
    /// Max slippage: 3 000 bps (30 %). Suitable for debut fighters.
    Tier8,
    /// Tier 10 — standard markets with 100 XLM minimum liquidity.
    /// Max slippage: 2 500 bps (25 %). Suitable for regional title fights.
    Tier10,
    /// Tier 12 — established markets with 120 XLM minimum liquidity.
    /// Max slippage: 2 000 bps (20 %). Suitable for major title fights.
    Tier12,
    /// Tier 14 — high-volume markets with 140 XLM minimum liquidity.
    /// Max slippage: 1 500 bps (15 %). Suitable for world championship bouts.
    Tier14,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    FighterA,  // First boxer wins
    FighterB,  // Second boxer wins
    Draw,      // Match ends in a draw
    NoContest, // Fight invalidated (DQ, early stop, etc.)
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum BetSide {
    FighterA,
    FighterB,
    Draw,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OracleRole {
    Primary,  // Primary trusted oracle (e.g. BoxRec / ESPN feed)
    Fallback, // Used if primary oracle fails or disagrees
    Admin,    // Manual admin override used during dispute resolution
}

// ─── Structs ─────────────────────────────────────────────────────────────────

/// All identifying details about a scheduled boxing match.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FightDetails {
    /// Unique fight identifier — e.g. "FURY-USYK-2025-MAY"
    pub match_id: String,
    /// Full name or ID of the first boxer
    pub fighter_a: String,
    /// Full name or ID of the second boxer
    pub fighter_b: String,
    /// Weight class — e.g. "Heavyweight", "Super-Middleweight"
    pub weight_class: String,
    /// Unix timestamp (seconds) of scheduled fight start
    pub scheduled_at: u64,
    /// Venue name
    pub venue: String,
    /// True if a championship belt is on the line
    pub title_fight: bool,
}

/// Configuration parameters for a single market.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MarketConfig {
    /// Minimum bet in stroops (1 XLM = 10_000_000 stroops)
    pub min_bet_amount: i128,
    /// Maximum single bet in stroops
    pub max_bet: i128,
    /// Platform fee in basis points (200 = 2%)
    pub fee_bps: u32,
    /// Seconds before scheduled_at to stop accepting bets
    pub lock_before_secs: u64,
    /// Seconds after scheduled_at within which oracle must resolve
    pub resolution_window: u64,
    /// Market tier — determines pool depth requirements and slippage tolerance.
    /// e.g. 18 = Tier 18 (mid-range), 20 = Tier 20 (high-stakes).
    /// Tier 0 means untiered / default.
    pub tier: u32,
}

/// Configuration passed to MarketFactory on initialization.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FactoryConfig {
    /// Minimum bet in stroops for newly created markets (1 XLM = 10_000_000 stroops)
    pub default_min_bet: i128,
    /// Maximum single bet in stroops for newly created markets
    pub default_max_bet: i128,
    /// Platform fee in basis points (200 = 2%) for newly created markets
    pub default_fee_bps: u32,
    /// Seconds before scheduled_at to stop accepting bets (new markets)
    pub default_lock_before_secs: u64,
    /// Seconds after scheduled_at within which oracle must resolve (new markets)
    pub default_resolution_window: u64,
}

/// Global configuration for the prediction market system.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Dispute window duration in seconds (minimum 3600 = 1 hour)
    pub dispute_window_secs: u64,
    /// Minimum collateral required to seed a new AMM pool
    pub min_liquidity: i128,
}

/// A single bet placed by a user.
#[contracttype]
#[derive(Clone, Debug)]
pub struct BetRecord {
    /// Stellar address of the bettor
    pub bettor: Address,
    /// On-chain market ID
    pub market_id: u64,
    /// Which outcome the bettor backed
    pub side: BetSide,
    /// Amount staked in stroops
    pub amount: i128,
    /// Unix timestamp when the bet was placed
    pub placed_at: u64,
    /// True once winnings or refund have been claimed
    pub claimed: bool,
}

/// Optional outcome — used in MarketState to avoid Option<EnumType> which
/// is not supported by #[contracttype] in soroban-sdk 20.x.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OptionalOutcome {
    None,
    Some(Outcome),
}

/// Optional oracle role — same workaround as OptionalOutcome.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OptionalOracleRole {
    None,
    Some(OracleRole),
}

/// Optional market tier — same workaround as OptionalOutcome.
/// Present on markets that have been assigned a tier classification.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum OptionalMarketTier {
    None,
    Some(MarketTier),
}

/// Full runtime state of a market — stored inside the Market contract.
#[contracttype]
#[derive(Clone, Debug)]
pub struct MarketState {
    pub market_id: u64,
    pub fight: FightDetails,
    pub config: MarketConfig,
    pub status: MarketStatus,
    /// None until market is resolved
    pub outcome: OptionalOutcome,
    /// Total stroops staked on FighterA
    pub pool_a: i128,
    /// Total stroops staked on FighterB
    pub pool_b: i128,
    /// Total stroops staked on Draw
    pub pool_draw: i128,
    /// Sum of all three pools
    pub total_pool: i128,
    /// 0 until resolved
    pub resolved_at: u64,
    /// None until resolved
    pub oracle_used: OptionalOracleRole,
    /// AMM tier classification — determines liquidity requirements and slippage tolerance.
    /// Set at initialization; None for markets created before the tier system was introduced.
    pub tier: OptionalMarketTier,
}

/// Signed result report submitted by an oracle.
#[contracttype]
#[derive(Clone, Debug)]
pub struct OracleReport {
    pub match_id: String,
    pub outcome: Outcome,
    /// Unix timestamp when the oracle submitted this report
    pub reported_at: u64,
    /// Ledger timestamp when the report was stored on-chain (set by the contract).
    /// Used by clear_stale_reports to evict partial reports older than REPORT_TTL.
    pub submitted_at: u64,
    /// Ed25519 signature over concat(match_id_bytes, outcome_byte, reported_at_be)
    pub signature: BytesN<64>,
    /// Stellar address corresponding to the oracle signing keypair
    pub oracle_address: Address,
    /// Raw Ed25519 public key (32 bytes) matching oracle_address
    pub pub_key: BytesN<32>,
}

/// A non-zero, non-redeemed position held by a user in a specific market.
#[contracttype]
#[derive(Clone, Debug)]
pub struct UserPosition {
    pub market_id: u64,
    pub side: BetSide,
    /// Total unclaimed stake on this side in this market (stroops)
    pub amount: i128,
}

/// Receipt returned to the bettor after a successful claim.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimReceipt {
    pub bettor: Address,
    pub market_id: u64,
    /// Gross payout including original stake
    pub amount_won: i128,
    /// Platform fee deducted before transfer
    pub fee_deducted: i128,
    pub claimed_at: u64,
}

// ─── Treasury Audit Trail ─────────────────────────────────────────────────────

/// The type of fund-moving operation recorded in the treasury audit ledger.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum AuditAction {
    /// A market deposited fees into the treasury.
    FeeDeposited,
    /// Fees were received from a registered market (per-market breakdown).
    FeeReceived,
    /// The admin withdrew accumulated fees.
    FeeWithdrawn,
    /// The admin emergency-drained all fees for a token.
    FeeDrained,
}

/// An immutable, append-only entry in the treasury audit ledger.
///
/// Entries are keyed by a monotonically increasing `id` and are never mutated
/// or removed — they form a tamper-evident history of every fund movement.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEntry {
    /// Monotonically increasing entry id (1-based).
    pub id: u64,
    /// The action that produced this entry.
    pub action: AuditAction,
    /// The token involved in the operation.
    pub token: Address,
    /// The signed amount moved (positive for in, negative for out).
    pub amount: i128,
    /// The acting address (market or admin).
    pub actor: Address,
    /// Ledger timestamp when the entry was recorded.
    pub timestamp: u64,

// ─── Treasury Audit ───────────────────────────────────────────────────────────

/// Immutable audit-log entry written to ledger storage every time fees are
/// withdrawn.  Entries are keyed by a monotonically-increasing sequence number
/// (`AUDIT_LOG_SEQ`) so they can never be overwritten.
///
/// The entry is stored in TEMPORARY storage (survives for `min_temp_entry_ttl`
/// ledgers) and simultaneously emitted as an `audit_log_entry` event so
/// off-chain indexers can capture it durably.
#[contracttype]
#[derive(Clone, Debug)]
pub struct AuditEntry {
    /// Monotonically-increasing sequence number (1-based).
    pub seq: u64,
    /// Stellar address of the admin who initiated the withdrawal.
    pub admin: Address,
    /// Token that was withdrawn.
    pub token: Address,
    /// Amount withdrawn in stroops.
    pub amount: i128,
    /// Destination address that received the tokens.
    pub destination: Address,
    /// Ledger timestamp when the withdrawal executed.
    pub timestamp: u64,
    /// Day bucket (timestamp / 86400) — matches the DAILY_WITHDRAWN key.
    pub day_bucket: u64,
}
