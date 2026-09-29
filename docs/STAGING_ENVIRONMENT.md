# Staging Environment Guide

## Overview

The staging environment is a production-like environment for pre-production validation before deploying to production.

### Key Features

- Separate PostgreSQL database: `bankerchanger_staging`
- Isolated Redis instance with authentication
- Production-like Docker Compose configuration
- Automated CI/CD deployment on main branch
- E2E test suite integration
- Health checks and structured logging
- Separate environment variables and secrets

## Local Deployment

```bash
# Copy environment templates
cp .env.staging.example .env.staging
cp backend/.env.staging backend/.env.staging
cp indexer/.env.staging indexer/.env.staging
cp frontend/.env.staging frontend/.env.staging

# Start staging environment
docker compose -f docker-compose.yml -f docker-compose.staging.yml up

# Services available at:
# Frontend: http://localhost:3000
# Backend: http://localhost:3001
# PostgreSQL: localhost:5434
# Redis: localhost:6380
# Indexer: http://localhost:3003
```

## CI/CD Pipeline

The `.github/workflows/deploy-staging.yml` workflow:

1. **Triggers**: Push to `main` branch with relevant changes
2. **Build & Test**: Builds Docker images for backend, frontend, indexer
3. **E2E Tests**: Runs against staging database
4. **Lint & Security**: TypeScript linting, type checking, secret scanning
5. **Deploy**: Pushes images to GitHub Container Registry
6. **Notify**: Deployment status notifications

## Environment Variables

All staging environment files include:
- Stellar network configuration (testnet)
- Separate database credentials
- Staging-specific API endpoints
- Debug-level logging
- Separate JWT/auth secrets

See `.env.staging.example` for full reference.

## Testing

### E2E Tests
```bash
cd backend
npm run test:e2e
```

### Local Testing
```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml up
# Run tests against local staging
DATABASE_URL=postgresql://bankerchanger_staging:staging_secure_password@localhost:5434/bankerchanger_staging npm run test:e2e
```

## Monitoring

### Health Checks
```bash
curl http://localhost:3001/health  # Backend
wget http://localhost:3000         # Frontend
```

### Logs
```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml logs -f backend
docker compose -f docker-compose.yml -f docker-compose.staging.yml logs -f frontend
```

## Database

### Migrations
Migrations run automatically when services start:
```bash
docker exec bankerchanger-backend npm run migrate:up
```

### Reset Database
```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml down -v
docker compose -f docker-compose.yml -f docker-compose.staging.yml up
```

## Production Promotion

Checklist before promoting to production:
- [ ] All E2E tests pass in staging
- [ ] Load tests show acceptable performance
- [ ] Security scans are clean
- [ ] Database migrations validated
- [ ] Monitoring and alerting configured
- [ ] Stakeholder approval obtained
- [ ] Rollback plan documented

## Troubleshooting

### Services won't start
```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml build --no-cache
```

### Database connection errors
Verify connection string matches database credentials in environment files.

### Port conflicts
Edit `.env.staging` to change port mappings:
```
POSTGRES_PORT=5435
REDIS_PORT=6381
BACKEND_PORT=3002
```

## Architecture

```
GitHub (main push)
    ↓
CI/CD Pipeline (build, test, security)
    ↓
Staging Environment
├─ PostgreSQL (bankerchanger_staging)
├─ Redis (with auth)
├─ Indexer
├─ Backend API
└─ Frontend
    ↓
E2E Tests
    ↓
Production Ready
```

## See Also

- [README.md](../README.md) - Quick start
- [Getting Started](./GETTING_STARTED.md) - General setup
- [Architecture](./architecture.md) - System design
