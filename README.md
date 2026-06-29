# BANKERCHANGER

Decentralized boxing-only prediction market built on Stellar Soroban.

## Stack

| Layer | Technology |
|---|---|
| Smart Contracts | Rust / Soroban (Stellar) |
| Backend | Node.js / TypeScript |
| Frontend | Next.js 14 / TypeScript / Tailwind CSS |
| Database | PostgreSQL 15 |
| Cache | Redis 7 |
| Wallet | Freighter / Albedo |

## Project Structure

```
contracts/    Soroban smart contracts (MarketFactory, Market, Treasury)
backend/      Indexer + REST API
frontend/     Next.js web app
docs/         Architecture and API documentation
```

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-org/boxmeout.git && cd boxmeout

# 2. Set up environment files
cp backend/.env.example backend/.env
cp indexer/.env.example indexer/.env
cp frontend/.env.example frontend/.env
# Edit .env files with your configuration

# 3. Start all services with one command
docker compose up

# The full stack is now running:
# - PostgreSQL:  localhost:5432
# - Redis:       localhost:6379
# - Indexer:     localhost:3002
# - Backend API: localhost:3001
# - Frontend:    localhost:3000
```

### Development Mode (Local)

If you prefer to run services locally without Docker:

```bash
# 1. Start only infrastructure services
docker compose up postgres redis

# 2. Backend (in separate terminal)
cd backend && npm install && npm run dev

# 3. Indexer (in separate terminal)
cd indexer && npm install && npm run dev

# 4. Frontend (in separate terminal)
cd frontend && npm install && npm run dev
```

## Contract Deployment

Requires [Rust](https://rustup.rs/) and the [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli).

```bash
cd contracts

# Build optimized WASM for all contracts
cargo build --workspace
# or: stellar contract build

# Deploy to Testnet
export ADMIN_SECRET_KEY=S...          # your Stellar secret key
export ORACLE_ADDRESSES=G...,G...     # optional: comma-separated oracle addresses
export DEFAULT_FEE_BPS=200            # optional: platform fee (default 200 = 2%)
./scripts/deploy.sh testnet
```

Deployed addresses are saved to `contracts/deployments.json`:

```json
{
  "network": "testnet",
  "deployedAt": "2025-01-01T00:00:00Z",
  "contracts": {
    "treasury":      { "address": "C..." },
    "marketFactory": { "address": "C...", "defaultFeeBps": 200 },
    "market":        { "wasmHash": "abc123..." }
  },
  "admin": "G..."
}
```

Deployment order: `shared` (build only) → `treasury` → `market_factory` → `market` (wasm upload).

## Documentation

- **[Getting Started Guide](docs/GETTING_STARTED.md)** — Complete setup guide with Docker
- [Contributing Guidelines](docs/contributing.md)
- [Architecture Overview](docs/architecture.md) — System diagram, data flows, sequence diagrams
- [API Rate Limits](docs/api-rate-limits.md) — Rate limit values, headers, client best practices
- [Observability Guide](docs/observability.md) — Prometheus metric names, alerting, logging
- [Operational Runbook](docs/runbook.md) — Incident response procedures for production

## License

MIT
