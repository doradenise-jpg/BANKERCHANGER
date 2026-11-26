use soroban_sdk::contracterror;

/// Error codes returned by the betting market contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MarketError {
    /// The market has not been initialized yet.
    NotInitialized = 1,
    /// The market has already been initialized.
    AlreadyInitialized = 2,
    /// The market is not open for placing bets.
    MarketNotOpen = 3,
    /// The market has already been locked.
    MarketAlreadyLocked = 4,
    /// The market has not been locked yet.
    MarketNotLocked = 5,
    /// The market has already been resolved.
    MarketAlreadyResolved = 6,
    /// The market has not been resolved yet.
    MarketNotResolved = 7,
    /// The provided bet amount is invalid (e.g. zero or negative).
    InvalidBetAmount = 8,
    /// The provided outcome is invalid for this market.
    InvalidOutcome = 9,
    /// The bet does not belong to the provided bettor.
    BetNotOwnedByBettor = 10,
    /// The bet has already been claimed.
    BetAlreadyClaimed = 11,
    /// The bet did not win and cannot be claimed.
    BetNotWinner = 12,
    /// The bet id does not exist.
    BetNotFound = 13,
    /// No winning pool exists to compute payouts from.
    EmptyWinningPool = 14,
    /// Arithmetic overflow occurred during payout computation.
    Overflow = 15,
    /// The caller is not authorized to perform this action.
    Unauthorized = 16,
}
