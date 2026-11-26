// contracts/testing/mod.rs
//
// Shared contract testing harness.
//
// Provides:
//   * `MockStorage` — a thin wrapper over `Env` storage that simulates Soroban
//     ledger state (persistent / temporary / instance) with helpers for
//     seeding, reading and clearing entries.
//   * Mock fight fixtures and factory functions for markets, bets and oracle
//     reports.
//   * A signed oracle report builder with configurable outcomes.
//
// This module is only compiled for tests or when the `testutils` feature is
// enabled, so it never ends up in production WASM.

#![cfg(any(test, feature = "testutils"))]

use soroban_sdk::{
    contracttype, symbol_short, xdr::ToXdr, Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Mock ledger / storage
// ---------------------------------------------------------------------------

/// Storage durability buckets mirroring Soroban's ledger model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageKind {
    Persistent,
    Temporary,
    Instance,
}

/// A wrapper over `Env` storage that simulates Soroban ledger state.
///
/// All keys are namespaced with a caller-supplied prefix so multiple logical
/// "contracts" can share a single `Env` without colliding.
pub struct MockStorage {
    env: Env,
    prefix: Symbol,
}

impl MockStorage {
    /// Create a new mock storage bound to `env` under the given namespace.
    pub fn new(env: &Env, namespace: &str) -> Self {
        let prefix = match namespace {
            "market" => symbol_short!("market"),
            "bet" => symbol_short!("bet"),
            "oracle" => symbol_short!("oracle"),
            _ => symbol_short!("mock"),
        };
        Self {
            env: env.clone(),
            prefix,
        }
    }

    /// The underlying environment.
    pub fn env(&self) -> &Env {
        &self.env
    }

    /// The namespace prefix used for all keys.
    pub fn prefix(&self) -> Symbol {
        self.prefix.clone()
    }

    /// Build a namespaced key from a short symbol.
    fn key(&self, name: Symbol) -> (Symbol, Symbol) {
        (self.prefix.clone(), name)
    }

    /// Write a value into the given storage bucket.
    pub fn set<V>(&self, kind: StorageKind, name: Symbol, value: &V)
    where
        V: IntoVal<Env, soroban_sdk::Val>,
    {
        let key = self.key(name);
        match kind {
            StorageKind::Persistent => self.env.storage().persistent().set(&key, value),
            StorageKind::Temporary => self.env.storage().temporary().set(&key, value),
            StorageKind::Instance => self.env.storage().instance().set(&key, value),
        }
    }

    /// Read a value from the given storage bucket, if present.
    pub fn get<V>(&self, kind: StorageKind, name: Symbol) -> Option<V>
    where
        V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>,
    {
        let key = self.key(name);
        match kind {
            StorageKind::Persistent => self.env.storage().persistent().get(&key),
            StorageKind::Temporary => self.env.storage().temporary().get(&key),
            StorageKind::Instance => self.env.storage().instance().get(&key),
        }
    }

    /// Returns true if the key exists in the given bucket.
    pub fn has(&self, kind: StorageKind, name: Symbol) -> bool {
        let key = self.key(name);
        match kind {
            StorageKind::Persistent => self.env.storage().persistent().has(&key),
            StorageKind::Temporary => self.env.storage().temporary().has(&key),
            StorageKind::Instance => self.env.storage().instance().has(&key),
        }
    }

    /// Remove a key from the given bucket.
    pub fn remove(&self, kind: StorageKind, name: Symbol) {
        let key = self.key(name);
        match kind {
            StorageKind::Persistent => self.env.storage().persistent().remove(&key),
            StorageKind::Temporary => self.env.storage().temporary().remove(&key),
            StorageKind::Instance => self.env.storage().instance().remove(&key),
        }
    }

    /// Extend the TTL of a persistent entry, simulating ledger bumping.
    pub fn bump_persistent(&self, name: Symbol, threshold: u32, extend_to: u32) {
        let key = self.key(name);
        self.env
            .storage()
            .persistent()
            .extend_ttl(&key, threshold, extend_to);
    }

    /// Extend the TTL of a temporary entry.
    pub fn bump_temporary(&self, name: Symbol, threshold: u32, extend_to: u32) {
        let key = self.key(name);
        self.env
            .storage()
            .temporary()
            .extend_ttl(&key, threshold, extend_to);
    }

    /// Advance the simulated ledger sequence number.
    pub fn set_ledger_sequence(&self, sequence: u32) {
        self.env.ledger().set_sequence_number(sequence);
    }

    /// Advance the simulated ledger timestamp (in seconds).
    pub fn set_ledger_timestamp(&self, timestamp: u64) {
        self.env.ledger().set_timestamp(timestamp);
    }

    /// Current simulated ledger sequence number.
    pub fn ledger_sequence(&self) -> u32 {
        self.env.ledger().sequence()
    }

    /// Current simulated ledger timestamp.
    pub fn ledger_timestamp(&self) -> u64 {
        self.env.ledger().timestamp()
    }
}

// ---------------------------------------------------------------------------
// Mock domain types
// ---------------------------------------------------------------------------

/// A mock market fixture.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MockMarket {
    pub id: u64,
    pub creator: Address,
    pub question: Symbol,
    pub outcome_count: u32,
    pub resolved: bool,
    pub winning_outcome: u32,
    pub deadline: u64,
}

/// A mock bet fixture.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MockBet {
    pub id: u64,
    pub market_id: u64,
    pub bettor: Address,
    pub outcome: u32,
    pub amount: i128,
    pub claimed: bool,
}

/// A mock oracle report fixture.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MockOracleReport {
    pub market_id: u64,
    pub outcome: u32,
    pub timestamp: u64,
    pub oracle: Address,
    pub signature: BytesN<64>,
}

/// A mock fight fixture used to seed market questions.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MockFight {
    pub id: u64,
    pub fighter_a: Symbol,
    pub fighter_b: Symbol,
    pub scheduled_at: u64,
}

// ---------------------------------------------------------------------------
// Mock fight fixtures
// ---------------------------------------------------------------------------

/// Returns a deterministic list of mock fights for use in tests.
pub fn mock_fights(env: &Env) -> Vec<MockFight> {
    let mut fights = Vec::new(env);
    fights.push_back(MockFight {
        id: 1,
        fighter_a: symbol_short!("ali"),
        fighter_b: symbol_short!("frazier"),
        scheduled_at: 1_700_000_000,
    });
    fights.push_back(MockFight {
        id: 2,
        fighter_a: symbol_short!("tyson"),
        fighter_b: symbol_short!("holmes"),
        scheduled_at: 1_700_086_400,
    });
    fights.push_back(MockFight {
        id: 3,
        fighter_a: symbol_short!("mayweather"),
        fighter_b: symbol_short!("pacman"),
        scheduled_at: 1_700_172_800,
    });
    fights
}

/// Returns a single mock fight by id, if it exists.
pub fn mock_fight(env: &Env, id: u64) -> Option<MockFight> {
    let fights = mock_fights(env);
    for i in 0..fights.len() {
        let f = fights.get(i).unwrap();
        if f.id == id {
            return Some(f);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/// Create a test market with sensible defaults.
///
/// * `id` — market identifier
/// * `creator` — market creator address
/// * `outcome_count` — number of possible outcomes (>= 2)
pub fn make_market(env: &Env, id: u64, creator: Address, outcome_count: u32) -> MockMarket {
    let outcome_count = if outcome_count < 2 { 2 } else { outcome_count };
    MockMarket {
        id,
        creator,
        question: symbol_short!("winner"),
        outcome_count,
        resolved: false,
        winning_outcome: 0,
        deadline: env.ledger().timestamp() + 86_400,
    }
}

/// Create a resolved test market with the given winning outcome.
pub fn make_resolved_market(
    env: &Env,
    id: u64,
    creator: Address,
    outcome_count: u32,
    winning_outcome: u32,
) -> MockMarket {
    let mut market = make_market(env, id, creator, outcome_count);
    market.resolved = true;
    market.winning_outcome = winning_outcome;
    market
}

/// Create a test bet with sensible defaults.
pub fn make_bet(
    env: &Env,
    id: u64,
    market_id: u64,
    bettor: Address,
    outcome: u32,
    amount: i128,
) -> MockBet {
    let _ = env;
    MockBet {
        id,
        market_id,
        bettor,
        outcome,
        amount,
        claimed: false,
    }
}

/// Create a test bet that has already been claimed.
pub fn make_claimed_bet(
    env: &Env,
    id: u64,
    market_id: u64,
    bettor: Address,
    outcome: u32,
    amount: i128,
) -> MockBet {
    let mut bet = make_bet(env, id, market_id, bettor, outcome, amount);
    bet.claimed = true;
    bet
}

// ---------------------------------------------------------------------------
// Signed oracle report builder
// ---------------------------------------------------------------------------

/// Builder for signed mock oracle reports with configurable outcomes.
pub struct OracleReportBuilder<'a> {
    env: &'a Env,
    market_id: u64,
    outcome: u32,
    timestamp: Option<u64>,
    oracle: Option<Address>,
    secret: Bytes,
}

impl<'a> OracleReportBuilder<'a> {
    /// Start building a report for `market_id` with the given `outcome`.
    pub fn new(env: &'a Env, market_id: u64, outcome: u32) -> Self {
        Self {
            env,
            market_id,
            outcome,
            timestamp: None,
            oracle: None,
            secret: Bytes::from_slice(env, b"mock-oracle-secret"),
        }
    }

    /// Override the report timestamp.
    pub fn timestamp(mut self, timestamp: u64) -> Self {
        self.timestamp = Some(timestamp);
        self
    }

    /// Override the oracle address.
    pub fn oracle(mut self, oracle: Address) -> Self {
        self.oracle = Some(oracle);
        self
    }

    /// Override the signing secret used to derive the mock signature.
    pub fn secret(mut self, secret: &[u8]) -> Self {
        self.secret = Bytes::from_slice(self.env, secret);
        self
    }

    /// Build the signed report.
    pub fn build(self) -> MockOracleReport {
        let timestamp = self.timestamp.unwrap_or_else(|| self.env.ledger().timestamp());
        let oracle = self
            .oracle
            .unwrap_or_else(|| Address::generate(self.env));

        let signature = self.sign(self.market_id, self.outcome, timestamp, &oracle);

        MockOracleReport {
            market_id: self.market_id,
            outcome: self.outcome,
            timestamp,
            oracle,
            signature,
        }
    }

    /// Derive a deterministic 64-byte mock signature over the report payload.
    fn sign(&self, market_id: u64, outcome: u32, timestamp: u64, oracle: &Address) -> BytesN<64> {
        let mut payload = Bytes::new(self.env);
        payload.append(&Bytes::from_slice(self.env, &market_id.to_be_bytes()));
        payload.append(&Bytes::from_slice(self.env, &outcome.to_be_bytes()));
        payload.append(&Bytes::from_slice(self.env, &timestamp.to_be_bytes()));
        payload.append(&oracle.clone().to_xdr(self.env));
        payload.append(&self.secret);

        let hash = self.env.crypto().sha256(&payload);
        let digest = hash.to_array();

        // Expand the 32-byte digest into a 64-byte signature deterministically.
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&digest);
        for i in 0..32 {
            sig[32 + i] = digest[i] ^ 0xA5;
        }
        BytesN::from_array(self.env, &sig)
    }
}

/// Convenience factory for a signed oracle report with a configurable outcome.
pub fn make_oracle_report(env: &Env, market_id: u64, outcome: u32) -> MockOracleReport {
    OracleReportBuilder::new(env, market_id, outcome).build()
}

/// Convenience factory for a signed oracle report from a specific oracle.
pub fn make_oracle_report_from(
    env: &Env,
    market_id: u64,
    outcome: u32,
    oracle: Address,
) -> MockOracleReport {
    OracleReportBuilder::new(env, market_id, outcome)
        .oracle(oracle)
        .build()
}

/// Verify that a mock report's signature matches the expected derivation.
///
/// Useful in tests that exercise signature-checking code paths.
pub fn verify_oracle_report(env: &Env, report: &MockOracleReport) -> bool {
    let builder = OracleReportBuilder::new(env, report.market_id, report.outcome)
        .timestamp(report.timestamp)
        .oracle(report.oracle.clone());
    let expected = builder.sign(
        report.market_id,
        report.outcome,
        report.timestamp,
        &report.oracle,
    );
    expected == report.signature
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/// Seed a market into mock storage.
pub fn seed_market(storage: &MockStorage, market: &MockMarket) {
    storage.set(StorageKind::Persistent, symbol_short!("mkt"), market);
}

/// Seed a bet into mock storage.
pub fn seed_bet(storage: &MockStorage, bet: &MockBet) {
    storage.set(StorageKind::Persistent, symbol_short!("bet"), bet);
}

/// Seed an oracle report into mock storage.
pub fn seed_oracle_report(storage: &MockStorage, report: &MockOracleReport) {
    storage.set(StorageKind::Persistent, symbol_short!("rpt"), report);
}

/// Build a fresh test environment with a default ledger state.
pub fn test_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_700_000_000);
    env.ledger().set_sequence_number(1);
    env
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_storage_roundtrip() {
        let env = test_env();
        let storage = MockStorage::new(&env, "market");

        let creator = Address::generate(&env);
        let market = make_market(&env, 1, creator, 3);

        seed_market(&storage, &market);
        assert!(storage.has(StorageKind::Persistent, symbol_short!("mkt")));

        let loaded: MockMarket = storage
            .get(StorageKind::Persistent, symbol_short!("mkt"))
            .unwrap();
        assert_eq!(loaded, market);

        storage.remove(StorageKind::Persistent, symbol_short!("mkt"));
        assert!(!storage.has(StorageKind::Persistent, symbol_short!("mkt")));
    }

    #[test]
    fn factories_produce_expected_defaults() {
        let env = test_env();
        let creator = Address::generate(&env);
        let bettor = Address::generate(&env);

        let market = make_market(&env, 7, creator, 2);
        assert_eq!(market.id, 7);
        assert!(!market.resolved);
        assert_eq!(market.outcome_count, 2);

        let bet = make_bet(&env, 1, 7, bettor, 1, 500);
        assert_eq!(bet.market_id, 7);
        assert_eq!(bet.amount, 500);
        assert!(!bet.claimed);
    }

    #[test]
    fn oracle_report_signature_is_deterministic_and_verifiable() {
        let env = test_env();
        let report = make_oracle_report(&env, 42, 1);
        assert_eq!(report.market_id, 42);
        assert_eq!(report.outcome, 1);
        assert!(verify_oracle_report(&env, &report));

        let again = make_oracle_report(&env, 42, 1);
        assert_eq!(report.signature, again.signature);
    }

    #[test]
    fn oracle_report_outcome_is_configurable() {
        let env = test_env();
        let a = make_oracle_report(&env, 1, 0);
        let b = make_oracle_report(&env, 1, 1);
        assert_ne!(a.signature, b.signature);
        assert_eq!(b.outcome, 1);
    }

    #[test]
    fn mock_fights_are_available() {
        let env = test_env();
        let fights = mock_fights(&env);
        assert_eq!(fights.len(), 3);
        assert!(mock_fight(&env, 2).is_some());
        assert!(mock_fight(&env, 99).is_none());
    }
}