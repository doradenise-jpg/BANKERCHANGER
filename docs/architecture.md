# BoxMeOut — Architecture Documentation

This document describes the high-level system architecture, data flows, and key interaction patterns of the BoxMeOut decentralized boxing prediction market.

## Table of Contents

- [System Overview](#system-overview)
- [System Diagram](#system-diagram)
- [Component Breakdown](#component-breakdown)
- [Data Flow: Contract Event to Frontend](#data-flow-contract-event-to-frontend)
- [Oracle Resolution Flow](#oracle-resolution-flow)
- [Bet Placement Flow](#bet-placement-flow)
- [Claim Payout Flow](#claim-payout-flow)

## System Overview

BoxMeOut is a full-stack decentralized application consisting of four main layers:

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Smart Contracts** | Rust / Soroban SDK | On-chain market logic, treasury, factory |
| **Indexer** | TypeScript | Polls Soroban events, persists to database |
| **Backend API** | Express / TypeScript | REST API, auth, caching, WebSocket feed |
| **Frontend** | Next.js 14 / React | User interface, wallet integration |

Supporting services include PostgreSQL (primary data store), Redis (caching and rate limiting), and Prometheus (metrics).

## System Diagram

```mermaid
graph LR
    subgraph Stellar Network
        MC[Market Contract]
        MF[Market Factory]
        TR[Treasury Contract]
    end

    subgraph Indexer
        PL[Event Poller]
    end

    subgraph Backend
        API[REST API]
        WS[WebSocket Server]
        CR[Cron Jobs]
        MT[Metrics /metrics]
    end

    subgraph Data Stores
        PG[(PostgreSQL)]
        RD[(Redis)]
    end

    subgraph Frontend
        UI[Next.js App]
    end

    subgraph External
        OR[Oracle Nodes]
        PR[Prometheus]
    end

    MC -->|Events| PL
    MF -->|Events| PL
    TR -->|Events| PL
    PL -->|Write| PG
    API -->|Read/Write| PG
    API -->|Cache| RD
    CR -->|Cleanup| PG
    WS -->|Push| UI
    UI -->|HTTP| API
    UI -->|WS| WS
    UI -->|Sign Tx| MC
    OR -->|Submit Report| API
    API -->|Resolve| MC
    MT -->|Scrape| PR
```

## Component Breakdown

### Smart Contracts (Soroban)

| Contract | Responsibility |
|----------|---------------|
| **shared** | Common types, error codes, AMM math, event helpers |
| **market_factory** | Creates markets, manages oracle whitelist, emergency pause |
| **market** | Individual market logic — bet placement, claims, refunds |
| **treasury** | Fund custody, withdrawal limits, payout distribution |

**Security features:** Reentrancy guards (CLAIMING flag), emergency pause, oracle whitelist enforcement, 2-of-3 oracle consensus.

### Indexer

The indexer runs as a standalone TypeScript process that:

1. Polls the Soroban RPC endpoint every 5 seconds via `getEvents()`.
2. Filters events by contract ID and topic.
3. Parses `scVal` event payloads.
4. Upserts event data into PostgreSQL.
5. Maintains a cursor (`indexer_checkpoints` table) for crash recovery.

### Backend API

Express.js application providing:

- **REST API** — Markets, bets, claims, admin, auth, oracle endpoints.
- **Authentication** — JWT with session version tracking, 2FA/TOTP support.
- **Rate Limiting** — Redis-backed, per-route IP and user-based limits.
- **Caching** — Redis with 30-second TTLs and pattern-based invalidation.
- **WebSocket** — Real-time activity feed for live market updates.
- **Cron Jobs** — Auto-resolution, auto-lock, session/token cleanup.
- **Metrics** — Prometheus counters and histograms on `/metrics`.

### Frontend

Next.js 14 App Router application with:

- **State management** — Zustand stores.
- **Data fetching** — TanStack React Query.
- **Wallet integration** — Stellar SDK for transaction signing.
- **Styling** — Tailwind CSS.

## Data Flow: Contract Event to Frontend

This diagram shows how an on-chain event propagates through the system to the end user.

```mermaid
sequenceDiagram
    participant SC as Soroban Contract
    participant IX as Indexer (Poller)
    participant DB as PostgreSQL
    participant API as REST API
    participant WS as WebSocket Server
    participant UI as Frontend

    SC->>IX: Emit contract event
    IX->>IX: Parse scVal payload
    IX->>DB: Upsert event record
    IX->>DB: Update indexer checkpoint

    Note over API: Cron or request triggers read

    UI->>API: GET /api/markets
    API->>DB: Query markets + events
    DB-->>API: Market data
    API-->>UI: JSON response

    API->>WS: Broadcast update
    WS->>UI: Push via WebSocket
    UI->>UI: Update UI state
```

## Oracle Resolution Flow

Oracles are whitelisted accounts that submit match outcome reports. Resolution requires 2-of-3 consensus.

```mermaid
sequenceDiagram
    participant O1 as Oracle 1
    participant O2 as Oracle 2
    participant O3 as Oracle 3
    participant API as Backend API
    participant DB as PostgreSQL
    participant MC as Market Contract

    Note over O1,O3: Boxing match concludes

    O1->>API: POST /api/oracle/report (outcome: fighter_a)
    API->>DB: Store oracle_report
    API-->>O1: 200 OK

    O2->>API: POST /api/oracle/report (outcome: fighter_a)
    API->>DB: Store oracle_report
    API->>DB: Check consensus (2 of 3 agree)

    Note over API: Consensus reached (2/3)

    API->>MC: invoke resolve(market_id, outcome)
    MC->>MC: Set market outcome, unlock claims
    MC-->>API: Resolution tx confirmed

    API->>DB: Update market status = resolved
    API->>API: Broadcast via WebSocket

    Note over O3: Oracle 3 report is accepted but not required
    O3->>API: POST /api/oracle/report (outcome: fighter_a)
    API->>DB: Store oracle_report (already resolved)
```

## Bet Placement Flow

```mermaid
sequenceDiagram
    participant U as User (Frontend)
    participant W as Wallet (Freighter)
    participant MC as Market Contract
    participant API as Backend API
    participant DB as PostgreSQL
    participant IX as Indexer

    U->>API: GET /api/markets/:id (check market open)
    API->>DB: Query market details
    DB-->>API: Market data (status: open)
    API-->>U: Market details + odds

    U->>U: Select side (fighter_a / fighter_b / draw)
    U->>U: Enter bet amount

    U->>W: Request transaction signature
    W-->>U: Signed transaction

    U->>MC: Submit place_bet(market_id, side, amount)
    MC->>MC: Validate market open, transfer XLM to pool
    MC->>MC: Emit BetPlaced event

    IX->>MC: Poll events
    IX->>DB: Upsert bet record
    IX->>DB: Update market pool totals

    API->>DB: Read updated market
    API-->>U: Updated odds via WebSocket
```

## Claim Payout Flow

```mermaid
sequenceDiagram
    participant U as User (Frontend)
    participant W as Wallet (Freighter)
    participant MC as Market Contract
    participant TR as Treasury Contract
    participant API as Backend API
    participant DB as PostgreSQL

    Note over MC: Market resolved, outcome set

    U->>API: GET /api/markets/:id (check resolved)
    API->>DB: Query market + user bets
    DB-->>API: Market resolved, user has winning bet
    API-->>U: Claimable payout amount

    U->>W: Request claim transaction signature
    W-->>U: Signed transaction

    U->>MC: Submit claim(market_id, bet_id)
    MC->>MC: Verify bet on winning side
    MC->>MC: Set CLAIMING flag (reentrancy guard)
    MC->>TR: Request payout transfer
    TR->>U: Transfer XLM payout
    MC->>MC: Clear CLAIMING flag
    MC->>MC: Emit PayoutClaimed event

    API->>DB: Update bet status = claimed
    API-->>U: Confirmation via WebSocket
```
