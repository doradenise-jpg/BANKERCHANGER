//! ============================================================
//! BANKERCHANGER — Contract Error Types
//! Every contract function returns Result<T, ContractError>.
//! No unwrap() allowed in contract code.
//! ============================================================

use soroban_sdk::contracterror;

#[contracterror]
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
    MarketPaused = 48,

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
    FactoryPaused = 50,
    /// Oracle address already in whitelist
    OracleAlreadyWhitelisted = 51,
    /// Too many markets were requested in one query
    TooManyMarkets = 52,
    /// Market wasm hash has not been configured yet
    WasmHashNotSet = 53,
    /// Oracle address is not on the factory whitelist
    OracleNotWhitelisted = 54,

    // ── Reentrancy ─────────────────────────────────────────
    /// A claim or refund transfer is already in progress
    ReentrancyGuard = 60,

    // ── Slippage ────────────────────────────────────────────
    /// Computed shares out are below the caller's min_shares_out tolerance
    SlippageExceeded = 61,

    // ── Reserve ────────────────────────────────────────────
    /// Withdrawal would bring treasury reserves below the configured reserve floor.
    ReserveFloorBreached = 62,
    /// Caller does not hold enough tokens to fund the requested seed liquidity.
    InsufficientSeedLiquidity = 63,

    // ── Arithmetic ─────────────────────────────────────────
    /// Multiply-divide result cannot be represented as i128
    MathOverflow = 70,

    // ── Fighter / Fight Validation ──────────────────────────
    /// Both fighter names resolve to the same identity after normalisation
    DuplicateFighterName = 71,
    /// Fight date is in the past or does not meet the minimum market duration
    InvalidFightDate = 72,

    // ── Market Lifecycle ───────────────────────────────────
    /// ALLOW_DRAW cannot be toggled after bets have been placed
    BetsAlreadyPlaced = 73,

    // ── Treasury ───────────────────────────────────────────
    /// Fee-split basis points do not sum to exactly 10 000 or contain duplicate recipients
    InvalidFeeSplit = 74,
}

// Preserve the legacy source-level names without growing Soroban's exported
// error specification, which is already at its maximum number of cases.
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
