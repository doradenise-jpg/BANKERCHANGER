-- Migration: 001-initial-schema
-- Creates the core schema for markets, bets, oracle reports, blockchain events,
-- and indexer checkpoints. Idempotent: safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- markets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS markets (
    id              BIGSERIAL PRIMARY KEY,
    market_id       TEXT NOT NULL UNIQUE,
    question        TEXT NOT NULL,
    description     TEXT,
    category        TEXT,
    creator_address TEXT NOT NULL,
    end_time        TIMESTAMPTZ NOT NULL,
    resolution_time TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'open',
    outcome         TEXT,
    total_bets      NUMERIC(38, 0) NOT NULL DEFAULT 0,
    total_volume    NUMERIC(38, 0) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_markets_status ON markets (status);
CREATE INDEX IF NOT EXISTS idx_markets_creator_address ON markets (creator_address);

-- ---------------------------------------------------------------------------
-- bets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bets (
    id             BIGSERIAL PRIMARY KEY,
    market_id      BIGINT NOT NULL REFERENCES markets (id) ON DELETE CASCADE,
    bettor_address TEXT NOT NULL,
    outcome        TEXT NOT NULL,
    amount         NUMERIC(38, 0) NOT NULL,
    tx_hash        TEXT NOT NULL,
    ledger         BIGINT,
    claimed        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bets_market_id ON bets (market_id);
CREATE INDEX IF NOT EXISTS idx_bets_bettor_address ON bets (bettor_address);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bets_tx_hash_unique ON bets (tx_hash);

-- ---------------------------------------------------------------------------
-- oracle_reports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oracle_reports (
    id             BIGSERIAL PRIMARY KEY,
    market_id      BIGINT NOT NULL REFERENCES markets (id) ON DELETE CASCADE,
    oracle_address TEXT NOT NULL,
    outcome        TEXT NOT NULL,
    report_data    JSONB,
    tx_hash        TEXT,
    ledger         BIGINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oracle_reports_market_id ON oracle_reports (market_id);

-- ---------------------------------------------------------------------------
-- blockchain_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blockchain_events (
    id          BIGSERIAL PRIMARY KEY,
    contract_id TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    tx_hash     TEXT NOT NULL,
    ledger      BIGINT NOT NULL,
    event_index INTEGER NOT NULL DEFAULT 0,
    payload     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blockchain_events_unique
    ON blockchain_events (tx_hash, event_index);
CREATE INDEX IF NOT EXISTS idx_blockchain_events_ledger ON blockchain_events (ledger);

-- ---------------------------------------------------------------------------
-- indexer_checkpoints
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexer_checkpoints (
    id          BIGSERIAL PRIMARY KEY,
    indexer_name TEXT NOT NULL UNIQUE,
    last_ledger BIGINT NOT NULL DEFAULT 0,
    last_cursor TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
