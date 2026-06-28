# Contributing to BoxMeOut

Thank you for your interest in contributing to BoxMeOut! This document provides guidelines for development and deployment.

## Table of Contents

- [Development Environment Setup](#development-environment-setup)
- [Fork and Branch Naming](#fork-and-branch-naming)
- [Commit Format](#commit-format)
- [Pull Request Process](#pull-request-process)
- [Code Standards](#code-standards)
- [Local Contract Testing](#local-contract-testing)
- [Testing](#testing)
- [Code Review](#code-review)
- [Deployment](#deployment)
- [Reporting Issues](#reporting-issues)

## Development Environment Setup

### Prerequisites

- **Node.js** >= 18
- **PostgreSQL** 15+
- **Redis** 7+
- **Rust** (for Soroban contract development)
- **stellar-cli** (for contract deployment)
- **Docker & Docker Compose** (recommended)

### Quick Start with Docker

```bash
# Clone the repository
git clone https://github.com/doradenise-jpg/BANKERCHANGER.git
cd BANKERCHANGER

# Start all services (PostgreSQL, Redis, backend, frontend)
docker compose up -d

# Backend: http://localhost:3001
# Frontend: http://localhost:3000
```

### Manual Setup

**Backend:**

```bash
cd backend
cp .env.example .env          # Configure environment variables
npm install
npm run migrate               # Run database migrations
npm run dev                   # Start dev server with hot reload
```

**Frontend:**

```bash
cd frontend
cp .env.example .env.local    # Configure environment variables
npm install
npm run dev                   # Start Next.js dev server
```

**Contracts:**

```bash
cd contracts
cargo build                   # Build all Soroban contracts
cargo test                    # Run contract unit tests
```

## Fork and Branch Naming

1. Fork the repository on GitHub.
2. Create a feature branch from `main`:

```bash
git checkout -b feat/your-feature-name    # New feature
git checkout -b fix/bug-description       # Bug fix
git checkout -b docs/topic                # Documentation
git checkout -b refactor/area             # Refactoring
```

**Branch naming conventions:**

| Prefix | Use case |
|--------|----------|
| `feat/` | New features or enhancements |
| `fix/` | Bug fixes |
| `docs/` | Documentation changes |
| `refactor/` | Code refactoring (no behavior change) |
| `test/` | Adding or updating tests |
| `chore/` | Build, CI, or tooling changes |

## Commit Format

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

**Examples:**

```
feat(backend): add market resolution endpoint
fix(contracts): prevent double-claim in treasury
docs(api): document rate limit headers
test(indexer): add event polling integration tests
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `perf`

**Scopes:** `backend`, `frontend`, `contracts`, `indexer`, `docs`, `api`

## Pull Request Process

1. Ensure your branch is up to date with `main`.
2. Run all tests locally before opening a PR.
3. Open a PR with a clear title following commit format conventions.
4. Fill in the PR template with:
   - Summary of changes
   - Related issue numbers (`Closes #123`)
   - Test plan
5. Request review from at least one maintainer.
6. Address all review feedback before merge.
7. PRs require passing CI checks before merge.

## Code Standards

- Use **TypeScript** for all new backend and frontend code.
- Follow ESLint configuration: `npm run lint`
- Use **Zod** for runtime input validation.
- Write tests for new features.
- Keep commit messages clear and descriptive.
- No `any` types without explanatory comments.
- Use Drizzle ORM for database operations.

## Local Contract Testing

### Running Contract Tests

```bash
cd contracts
cargo test                     # Run all contract tests
cargo test -p market           # Test specific contract
cargo test -- --nocapture      # Show stdout during tests
```

### Contract Test Structure

Tests live alongside contract source code in `contracts/<contract>/src/test.rs` or inline with `#[cfg(test)]` modules.

**Test pattern:**

```rust
#[test]
fn test_place_bet() {
    let env = Env::default();
    env.mock_all_auths();
    // ... setup and assertions
}
```

### Deploying Contracts to Testnet

```bash
cd contracts
export ADMIN_SECRET_KEY=S...
export STELLAR_RPC_URL=https://soroban-testnet.stellar.org  # Optional: custom RPC
./scripts/deploy.sh testnet
```

Deploy order: `shared` -> `treasury` -> `market_factory` -> `market` (WASM upload).

## Testing

```bash
# Backend tests
cd backend
npm run test                   # Jest unit & integration tests

# Frontend tests
cd frontend
npm run test                   # Jest component tests
npm run test:e2e               # Playwright end-to-end tests

# Contract tests
cd contracts
cargo test                     # Rust unit tests
```

## Code Review

Reviewers will check for:

- Correctness and completeness of the implementation.
- Test coverage for new code paths.
- Adherence to code standards and conventions.
- Security implications (input validation, auth checks).
- Performance impact (database queries, caching).
- Documentation for public APIs and complex logic.

## Deployment

### Contract Deployment

```bash
cd contracts
export ADMIN_SECRET_KEY=S...
export STELLAR_RPC_URL=https://soroban-testnet.stellar.org
./scripts/deploy.sh testnet
```

See `scripts/deploy.sh` for environment variable options and custom RPC node support.

### Backend Deployment

```bash
cd backend
npm run build
# Deploy to your hosting provider
```

### Frontend Deployment

```bash
cd frontend
npm run build
# Deploy dist/ to hosting provider
```

## Production Operations

When deploying to production, refer to the [Operational Runbook](./runbook.md) for:

- **Incident Response Procedures** — Step-by-step guides for common production incidents
- **Oracle Failure Handling** — Resolution procedures for unresolved markets
- **Treasury Management** — Withdrawal limit adjustments and emergency drainage
- **Contract Pause Operations** — Emergency pause and resume procedures
- **RPC Node Troubleshooting** — Diagnosis and recovery from blockchain connectivity issues
- **CLI Commands** — Quick reference for critical operations

## Reporting Issues

Please use GitHub Issues with:

- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (testnet/mainnet, git commit, browser/node version)

## License

All contributions are licensed under the MIT License.
