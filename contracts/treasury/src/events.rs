use soroban_sdk::{contracttype, Address, Env};

/// Emitted when a market deposits platform fees into the treasury.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeDeposited {
    pub market_id: u64,
    pub amount: i128,
}

/// Emitted when the treasury withdraws accumulated fees.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesWithdrawn {
    pub recipient: Address,
    pub amount: i128,
}

pub fn emit_fee_deposited(env: &Env, market_id: u64, amount: i128) {
    env.events()
        .publish(("fee_deposited",), FeeDeposited { market_id, amount });
}

pub fn emit_fees_withdrawn(env: &Env, recipient: &Address, amount: i128) {
    env.events().publish(
        ("fees_withdrawn",),
        FeesWithdrawn {
            recipient: recipient.clone(),
            amount,
        },
    );
}
