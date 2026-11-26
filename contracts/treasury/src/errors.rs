use soroban_sdk::contracterror;

/// Error codes returned by the Treasury contract.
///
/// Codes are stable and intended to be asserted against in tests and by
/// off-chain clients. Keep them grouped by concern.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TreasuryError {
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract has not been initialized yet.
    NotInitialized = 2,
    /// Caller is not authorized to perform this action.
    Unauthorized = 3,
    /// Fee amount must be strictly positive.
    InvalidFeeAmount = 4,
    /// Fee amount exceeds the configured maximum.
    FeeAmountTooLarge = 5,
    /// Requested withdrawal exceeds the tracked balance.
    InsufficientBalance = 6,
    /// Arithmetic overflow while updating balances.
    Overflow = 7,
    /// Provided token/asset address is invalid.
    InvalidToken = 8,
}
