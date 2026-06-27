# Contributing to BoxMeOut

Thank you for your interest in contributing to BoxMeOut! This document provides guidelines for development and deployment.

## Development Setup

See [Quick Start](./QUICK_START.md) for local development environment setup.

## Code Standards

- Use TypeScript for all new code
- Follow ESLint configuration (run `npm run lint`)
- Write tests for new features
- Keep commit messages clear and descriptive

## Deployment

### Contract Deployment

```bash
cd contracts
export ADMIN_SECRET_KEY=S...
export STELLAR_RPC_URL=https://soroban-testnet.stellar.org  # Optional: custom RPC
./scripts/deploy.sh testnet
```

See `scripts/deploy.sh` for environment variable options and custom RPC node support.

### Frontend Deployment

```bash
cd frontend
npm run build
# Deploy dist/ to hosting provider
```

### Backend Deployment

```bash
cd backend
npm run build
# Deploy to your hosting provider
```

## Production Operations

When deploying to production, refer to the [Operational Runbook](./runbook.md) for:

- **Incident Response Procedures** — Step-by-step guides for common production incidents
- **Oracle Failure Handling** — Resolution procedures for unresolved markets
- **Treasury Management** — Withdrawal limit adjustments and emergency drainage
- **Contract Pause Operations** — Emergency pause and resume procedures
- **RPC Node Troubleshooting** — Diagnosis and recovery from blockchain connectivity issues
- **CLI Commands** — Quick reference for critical operations

## Testing

```bash
# Frontend tests
cd frontend
npm run test

# Backend tests
cd backend
npm run test

# Contract tests
cd contracts
cargo test
```

## Reporting Issues

Please use GitHub Issues with:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (testnet/mainnet, git commit, browser/node version)

## License

All contributions are licensed under the MIT License.
