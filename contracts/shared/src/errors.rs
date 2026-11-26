//! ============================================================
//! BANKERCHANGER — Contract Error Types
//! Every contract function returns Result<T, ContractError>.
//! No unwrap() allowed in contract code.
//! ============================================================

use soroban_sdk::contracterror;

// XDR limits a single error enum specification to 50 cases. Keep all runtime
// error codes and conversions available to Rust clients.
#[contracterror(export = false)]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ContractError {
    // ── Authorization ──────────────────────────────────────
    /// Caller is not authorized to perform this action
    Unauthorized = 1,
    /// Caller is not the contract admin
    NotAdmin = 4,
    /// Caller is not a whitelisted oracle
    NotOracle = 5,
    /// Caller is not the factory contract
    NotFactory = 3,
    /// Market contract is not registered or approved
    UnregisteredMarket = 6,
    /// Admin transfer proposal acceptance window has elapsed
    AdminTransferExpired = 7,
    /// Admin timelock is active; proposal cannot be accepted yet
    AdminTimelockActive = 8,

    // ── Market State ───────────────────────────────────────
    /// Requested market ID does not exist
    MarketNotFound = 10,
    /// Market is not open for betting
    MarketNotOpen = 11,
    /// Market must be resolved before this operation
    MarketNotResolved = 12,
    /// Market has been cancelled and cannot perform this operation
    MarketCancelled = 13,
    /// Market has already been initialized
    AlreadyInitialized = 14,
    /// Provided time range or timestamps are invalid
    InvalidTimeRange = 15,
    /// Provided market configuration is invalid
    InvalidMarketParameters = 16,
    /// Market is not in the expected state for this operation
    InvalidMarketStatus = 17,
    /// Betting is closed because the lock threshold has been reached
    BettingClosed = 18,
    /// Bet amount exceeds maximum allowed
    BetTooLarge = 19,
    /// Market is paused
    MarketPaused = 29,

    // ── Bet Validation ─────────────────────────────────────
    /// Bet amount is below minimum allowed
    BetTooLow = 20,
    /// Transfer amount is insufficient for the requested operation
    InsufficientAmount = 21,
    /// Legacy error code retained for compatibility; multiple bets are now allowed
    AlreadyBet = 22,
    /// Bettor has already claimed winnings or refund
    AlreadyClaimed = 23,
    /// Invalid outcome for the current market state
    InvalidOutcome = 24,
    /// Bettor placed no bets in this market
    NoBetsFound = 25,
    /// Amount is below minimum allowed
    BelowMinimum = 26,
    /// Amount must be positive and non-zero
    InvalidAmount = 27,
    /// Bet would exceed the bettor's configured share of the market pool
    BetLimitExceeded = 28,

    // ── Oracle / Resolution ────────────────────────────────
    /// Oracle signature verification failed
    InvalidOracleSignature = 30,
    /// Resolution attempted outside of the allowed window
    ResolutionWindowExpired = 31,
    /// Two or more conflicting oracle reports were submitted
    ConflictingOracleReport = 32,
    /// Resolution was attempted before the scheduled fight start
    MarketNotStarted = 33,
    /// finalize_resolution called before the dispute cooldown window has elapsed
    DisputeCooldownActive = 34,
    /// finalize_resolution called on a market not in ResolutionPending state
    ResolutionNotPending = 35,
    /// Market was not configured to allow Draw outcome
    DrawNotAllowed = 36,

    // ── Treasury ───────────────────────────────────────────
    /// Fee withdrawals are temporarily paused
    WithdrawalsPaused = 40,
    /// Withdrawal exceeds configured daily or per-transaction limits
    DailyWithdrawalLimitExceeded = 41,
    /// Not enough balance is available for withdrawal
    InsufficientBalance = 42,
    /// Market is not approved to deposit or receive fees
    MarketNotApproved = 43,
    /// A fee extraction is already in progress; concurrent call rejected
    FeeExtractionInProgress = 44,
    /// The daily withdrawal cap has been reached for today's bucket
    DailyCapReached = 45,

    // ── Factory ────────────────────────────────────────────
    /// Factory is paused; new market creation is disabled
    FactoryPaused = 46,
    /// Oracle address already in whitelist
    OracleAlreadyWhitelisted = 47,
    /// Too many markets were requested in one query
    TooManyMarkets = 49,
    /// Market wasm hash has not been configured yet
    WasmHashNotSet = 37,
    /// Oracle address is not on the factory whitelist
    OracleNotWhitelisted = 38,

    // ── Reentrancy ─────────────────────────────────────────
    /// A claim or refund transfer is already in progress
    ReentrancyGuard = 39,

    // ── Slippage ────────────────────────────────────────────
    /// Computed shares out are below the caller's min_shares_out tolerance
    SlippageExceeded = 9,

    // ── Reserve ────────────────────────────────────────────
    /// Withdrawal would bring treasury reserves below the configured reserve floor.
    ReserveFloorBreached = 2,
    /// Caller does not hold enough tokens to fund the requested seed liquidity.
    InsufficientSeedLiquidity = 50,

    // ── Arithmetic ─────────────────────────────────────────
    /// Multiply-divide result cannot be represented as i128
    MathOverflow = 75,

    // ── Fighter / Fight Validation ──────────────────────────
    /// Both fighter names resolve to the same identity after normalisation
    DuplicateFighterName = 76,
    /// Fight date is in the past or does not meet the minimum market duration
    InvalidFightDate = 77,

    // ── Market Lifecycle ───────────────────────────────────
    /// ALLOW_DRAW cannot be toggled after bets have been placed
    BetsAlreadyPlaced = 78,

    // ── Treasury ───────────────────────────────────────────
    /// Fee-split basis points do not sum to exactly 10 000 or contain duplicate recipients
    InvalidFeeSplit = 79,
}

// Preserve the legacy source-level names without changing runtime codes.
#[allow(non_upper_case_globals)]
impl ContractError {
    /// Legacy name for `AdminTransferExpired`.
    pub const PendingAdminExpired: Self = Self::AdminTransferExpired;
    /// Legacy name for `MathOverflow`.
    pub const ArithmeticOverflow: Self = Self::MathOverflow;
    /// AMM could not allocate shares for the requested bet.
    pub const ZeroSharesAllocated: Self = Self::SlippageExceeded;
}

impl ContractError {
    /// Backwards-compatible name retained for callers using the former reserve error.
    #[allow(non_upper_case_globals)]
    pub const InsufficientReserve: Self = Self::ReserveFloorBreached;
}

// ── Error code → variant mapping ─────────────────────────────
//
// Every variant carries a unique numeric code in the range 1–50 so that
// invocation failures can be diagnosed from the code alone. The table below
// is the canonical reference; `all_error_codes_are_unique` guards it.
//
// | Code | Variant                      | Meaning                                            |
// |------|------------------------------|----------------------------------------------------|
// |  1   | Unauthorized                 | Caller not authorized for this action              |
// |  2   | ReserveFloorBreached         | Withdrawal would breach the treasury reserve floor |
// |  3   | NotFactory                   | Caller is not the factory contract                 |
// |  4   | NotAdmin                     | Caller is not the contract admin                   |
// |  5   | NotOracle                    | Caller is not a whitelisted oracle                 |
// |  6   | UnregisteredMarket           | Market not registered or approved                  |
// |  7   | AdminTransferExpired         | Admin transfer acceptance window elapsed           |
// |  8   | AdminTimelockActive          | Admin timelock still active                        |
// |  9   | SlippageExceeded             | Shares out below min_shares_out tolerance          |
// | 10   | MarketNotFound               | Market ID does not exist                           |
// | 11   | MarketNotOpen                | Market not open for betting                        |
// | 12   | MarketNotResolved            | Market must be resolved first                      |
// | 13   | MarketCancelled              | Market was cancelled                               |
// | 14   | AlreadyInitialized           | Market already initialized                         |
// | 15   | InvalidTimeRange             | Timestamps or time range invalid                   |
// | 16   | InvalidMarketParameters      | Market configuration invalid                       |
// | 17   | InvalidMarketStatus          | Market not in expected state                       |
// | 18   | BettingClosed                | Lock threshold reached; betting closed             |
// | 19   | BetTooLarge                  | Bet exceeds maximum allowed                        |
// | 20   | BetTooLow                    | Bet below minimum allowed                          |
// | 21   | InsufficientAmount           | Transfer amount insufficient                       |
// | 22   | AlreadyBet                   | Legacy code; multiple bets now allowed             |
// | 23   | AlreadyClaimed               | Winnings or refund already claimed                 |
// | 24   | InvalidOutcome               | Outcome invalid for current market state           |
// | 25   | NoBetsFound                  | Bettor placed no bets in this market               |
// | 26   | BelowMinimum                 | Amount below minimum allowed                       |
// | 27   | InvalidAmount                | Amount must be positive and non-zero               |
// | 28   | BetLimitExceeded             | Bet exceeds bettor's share of the pool             |
// | 29   | MarketPaused                 | Market is paused                                   |
// | 30   | InvalidOracleSignature       | Oracle signature verification failed               |
// | 31   | ResolutionWindowExpired      | Resolution outside allowed window                  |
// | 32   | ConflictingOracleReport      | Conflicting oracle reports submitted               |
// | 33   | MarketNotStarted             | Resolution before scheduled fight start            |
// | 34   | DisputeCooldownActive        | Dispute cooldown window not elapsed                |
// | 35   | ResolutionNotPending         | Market not in ResolutionPending state              |
// | 36   | DrawNotAllowed               | Market does not allow Draw outcome                 |
// | 37   | WasmHashNotSet               | Market wasm hash not configured                    |
// | 38   | OracleNotWhitelisted         | Oracle not on factory whitelist                    |
// | 39   | ReentrancyGuard              | Claim or refund transfer already in progress       |
// | 40   | WithdrawalsPaused            | Fee withdrawals temporarily paused                 |
// | 41   | DailyWithdrawalLimitExceeded | Withdrawal exceeds configured limits               |
// | 42   | InsufficientBalance          | Balance too low for withdrawal                     |
// | 43   | MarketNotApproved            | Market not approved to deposit or receive fees     |
// | 44   | FeeExtractionInProgress      | Concurrent fee extraction rejected                 |
// | 45   | DailyCapReached              | Daily withdrawal cap reached                       |
// | 46   | FactoryPaused                | Factory paused; market creation disabled           |
// | 47   | OracleAlreadyWhitelisted     | Oracle already whitelisted                         |
// | 48   | (reserved)                   | Former MarketPaused code; do not reuse             |
// | 49   | TooManyMarkets               | Too many markets requested in one query            |
// | 50   | InsufficientSeedLiquidity    | Caller lacks tokens for seed liquidity             |

impl core::fmt::Display for ContractError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "Error {}: {}", *self as u32, self.message())
    }
}

impl ContractError {
    /// Concise, human-readable description of this error.
    pub fn message(&self) -> &'static str {
        match self {
            // ── Authorization ──
            Self::Unauthorized => "caller is not authorized",
            Self::ReserveFloorBreached => "withdrawal would breach reserve floor",
            Self::NotFactory => "caller is not the factory",
            Self::NotAdmin => "caller is not the admin",
            Self::NotOracle => "caller is not a whitelisted oracle",
            Self::UnregisteredMarket => "market is not registered",
            Self::AdminTransferExpired => "admin transfer window expired",
            Self::AdminTimelockActive => "admin timelock is active",
            Self::SlippageExceeded => "slippage tolerance exceeded",

            // ── Market State ──
            Self::MarketNotFound => "market not found",
            Self::MarketNotOpen => "market is not open",
            Self::MarketNotResolved => "market is not resolved",
            Self::MarketCancelled => "market is cancelled",
            Self::AlreadyInitialized => "already initialized",
            Self::InvalidTimeRange => "invalid time range",
            Self::InvalidMarketParameters => "invalid market parameters",
            Self::InvalidMarketStatus => "invalid market status",
            Self::BettingClosed => "betting is closed",
            Self::BetTooLarge => "bet amount too large",
            Self::MarketPaused => "market is paused",

            // ── Bet Validation ──
            Self::BetTooLow => "bet amount too low",
            Self::InsufficientAmount => "insufficient amount",
            Self::AlreadyBet => "already bet",
            Self::AlreadyClaimed => "already claimed",
            Self::InvalidOutcome => "invalid outcome",
            Self::NoBetsFound => "no bets found",
            Self::BelowMinimum => "amount below minimum",
            Self::InvalidAmount => "invalid amount",
            Self::BetLimitExceeded => "bet limit exceeded",

            // ── Oracle / Resolution ──
            Self::InvalidOracleSignature => "invalid oracle signature",
            Self::ResolutionWindowExpired => "resolution window expired",
            Self::ConflictingOracleReport => "conflicting oracle report",
            Self::MarketNotStarted => "market has not started",
            Self::DisputeCooldownActive => "dispute cooldown active",
            Self::ResolutionNotPending => "resolution not pending",
            Self::DrawNotAllowed => "draw not allowed",

            // ── Treasury ──
            Self::WithdrawalsPaused => "withdrawals are paused",
            Self::DailyWithdrawalLimitExceeded => "daily withdrawal limit exceeded",
            Self::InsufficientBalance => "insufficient balance",
            Self::MarketNotApproved => "market is not approved",
            Self::FeeExtractionInProgress => "fee extraction in progress",
            Self::DailyCapReached => "daily cap reached",
            Self::InvalidFeeSplit => "invalid fee split",

            // ── Factory ──
            Self::FactoryPaused => "factory is paused",
            Self::OracleAlreadyWhitelisted => "oracle already whitelisted",
            Self::TooManyMarkets => "too many markets requested",
            Self::WasmHashNotSet => "wasm hash not set",
            Self::OracleNotWhitelisted => "oracle not whitelisted",

            // ── Reentrancy ──
            Self::ReentrancyGuard => "reentrancy detected",

            // ── Reserve ──
            Self::InsufficientSeedLiquidity => "insufficient seed liquidity",

            // ── Arithmetic ──
            Self::MathOverflow => "math overflow",

            // ── Fighter / Fight Validation ──
            Self::DuplicateFighterName => "duplicate fighter name",
            Self::InvalidFightDate => "invalid fight date",

            // ── Market Lifecycle ──
            Self::BetsAlreadyPlaced => "bets already placed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every variant, listed explicitly so a new variant forces an update here.
    const ALL_VARIANTS: &[ContractError] = &[
        ContractError::Unauthorized,
        ContractError::ReserveFloorBreached,
        ContractError::NotFactory,
        ContractError::NotAdmin,
        ContractError::NotOracle,
        ContractError::UnregisteredMarket,
        ContractError::AdminTransferExpired,
        ContractError::AdminTimelockActive,
        ContractError::SlippageExceeded,
        ContractError::MarketNotFound,
        ContractError::MarketNotOpen,
        ContractError::MarketNotResolved,
        ContractError::MarketCancelled,
        ContractError::AlreadyInitialized,
        ContractError::InvalidTimeRange,
        ContractError::InvalidMarketParameters,
        ContractError::InvalidMarketStatus,
        ContractError::BettingClosed,
        ContractError::BetTooLarge,
        ContractError::MarketPaused,
        ContractError::BetTooLow,
        ContractError::InsufficientAmount,
        ContractError::AlreadyBet,
        ContractError::AlreadyClaimed,
        ContractError::InvalidOutcome,
        ContractError::NoBetsFound,
        ContractError::BelowMinimum,
        ContractError::InvalidAmount,
        ContractError::BetLimitExceeded,
        ContractError::InvalidOracleSignature,
        ContractError::ResolutionWindowExpired,
        ContractError::ConflictingOracleReport,
        ContractError::MarketNotStarted,
        ContractError::DisputeCooldownActive,
        ContractError::ResolutionNotPending,
        ContractError::DrawNotAllowed,
        ContractError::WithdrawalsPaused,
        ContractError::DailyWithdrawalLimitExceeded,
        ContractError::InsufficientBalance,
        ContractError::MarketNotApproved,
        ContractError::FeeExtractionInProgress,
        ContractError::DailyCapReached,
        ContractError::InvalidFeeSplit,
        ContractError::FactoryPaused,
        ContractError::OracleAlreadyWhitelisted,
        ContractError::TooManyMarkets,
        ContractError::WasmHashNotSet,
        ContractError::OracleNotWhitelisted,
        ContractError::ReentrancyGuard,
        ContractError::InsufficientSeedLiquidity,
        ContractError::MathOverflow,
        ContractError::DuplicateFighterName,
        ContractError::InvalidFightDate,
        ContractError::BetsAlreadyPlaced,
    ];

    #[test]
    fn all_error_codes_are_unique() {
        let mut seen: [bool; 256] = [false; 256];
        for err in ALL_VARIANTS {
            let code = *err as u32;
            assert!(
                (1..=50).contains(&code),
                "error code {} out of range 1-50",
                code
            );
            assert!(!seen[code as usize], "duplicate error code {}", code);
            seen[code as usize] = true;
        }
    }

    #[test]
    fn display_includes_numeric_code() {
        let rendered = format!("{}", ContractError::NotAdmin);
        assert_eq!(rendered, "Error 4: caller is not the admin");
    }
}
