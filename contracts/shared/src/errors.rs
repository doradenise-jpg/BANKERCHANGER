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
    /// Pending admin transfer proposal has expired
    PendingAdminExpired = 7,

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

    // ── Bet Validation ─────────────────────────────────────
    /// Bet amount is below minimum allowed
    BetTooLow = 20,
    /// Transfer amount is insufficient for the requested operation
    InsufficientAmount = 21,
    /// Bettor has already placed a bet in this market
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

    // ── Oracle / Resolution ────────────────────────────────
    /// Oracle signature verification failed
    InvalidOracleSignature = 30,
    /// Resolution attempted outside of the allowed window
    ResolutionWindowExpired = 31,
    /// Two or more conflicting oracle reports were submitted
    ConflictingOracleReport = 32,
    /// Resolution was attempted before the scheduled fight start
    MarketNotStarted = 33,

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
    /// WASM hash for market contract has not been set by admin
    WasmHashNotSet = 53,
    /// Oracle address is not whitelisted
    OracleNotWhitelisted = 54,

    // ── Reentrancy ─────────────────────────────────────────
    /// A claim or refund transfer is already in progress
    ReentrancyGuard = 60,

    // ── Slippage ────────────────────────────────────────────
    /// Computed shares out are below the caller's min_shares_out tolerance
    SlippageExceeded = 61,
}
