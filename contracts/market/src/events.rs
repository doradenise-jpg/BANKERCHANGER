use soroban_sdk::{contracttype, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketCreated {
    pub market_id: u64,
    pub creator: Address,
    pub scheduled_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BetPlaced {
    pub market_id: u64,
    pub bettor: Address,
    pub outcome: u32,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketLocked {
    pub market_id: u64,
    pub locked_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketResolved {
    pub market_id: u64,
    pub winning_outcome: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WinningsClaimed {
    pub market_id: u64,
    pub claimer: Address,
    pub amount: i128,
}

pub fn emit_market_created(env: &Env, market_id: u64, creator: Address, scheduled_at: u64) {
    env.events().publish(
        ("market_created",),
        MarketCreated {
            market_id,
            creator,
            scheduled_at,
        },
    );
}

pub fn emit_bet_placed(env: &Env, market_id: u64, bettor: Address, outcome: u32, amount: i128) {
    env.events().publish(
        ("bet_placed",),
        BetPlaced {
            market_id,
            bettor,
            outcome,
            amount,
        },
    );
}

pub fn emit_market_locked(env: &Env, market_id: u64, locked_at: u64) {
    env.events().publish(
        ("market_locked",),
        MarketLocked {
            market_id,
            locked_at,
        },
    );
}

pub fn emit_market_resolved(env: &Env, market_id: u64, winning_outcome: u32) {
    env.events().publish(
        ("market_resolved",),
        MarketResolved {
            market_id,
            winning_outcome,
        },
    );
}

pub fn emit_winnings_claimed(env: &Env, market_id: u64, claimer: Address, amount: i128) {
    env.events().publish(
        ("winnings_claimed",),
        WinningsClaimed {
            market_id,
            claimer,
            amount,
        },
    );
}
