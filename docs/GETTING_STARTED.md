# Getting Started with BANKERCHANGER

Complete guide to get the full stack running on your local machine.

## Prerequisites

- **Docker & Docker Compose** (v3.9+)
- **Node.js 20+** (for local development)
- **Git**

Optional (for contract development):
- **Rust** via [rustup](https://rustup.rs/)
- **Stellar CLI** via [Stellar documentation](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)

## Quick Start - Full Stack with Docker

The fastest way to get everything running:

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/boxmeout.git
cd boxmeout
```

### 2. Set Up Environment Files

```bash
# Backend
cp backend/.env.example backend/.env

# Indexer
cp indexer/.env.example indexer/.env

# Frontend
cp frontend/.env.example frontend/.env
```

Edit each `.env` file with your configuration (see [Environment Variables](#environment-variables) below).

### 3. Start All Services

```bash
docker compose up
```

Or run in detached mode:

```bash
docker compose up -d
```

### 4. Verify All Services Are Running

```bash
docker compose ps
```

You should see:
- ✅ `postgres` - Database (port 5432)
- ✅ `redis` - Cache (port 6379)
- ✅ `indexer` - Stellar event indexer (port 3002)
- ✅ `backend` - REST API (port 3001)
- ✅ `frontend` - Web app (port 3000)

### 5. Access the Application

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001
- **Indexer API**: http://localhost:3002
- **API Docs (if enabled)**: http://localhost:3001/docs

### 6. Check Service Health

```bash
# Backend health check
curl http://localhost:3001/health

# Expected response:
{
  "status": "ok",
  "db": "connected",
  "redis": "connected",
  "dbPool": {
    "totalCount": 10,
    "idleCount": 10,
    "waitingCount": 0
  }
}
```

## Development Mode (Local)

If you want to run services locally for development (hot reload, debugging):

### 1. Start Infrastructure Only

```bash
docker compose up postgres redis
```

### 2. Run Backend Locally

```bash
cd backend
npm install
npm run dev
```

Backend will run on http://localhost:3001 with hot reload.

### 3. Run Indexer Locally

```bash
cd indexer
npm install
npm run dev
```

Indexer will run on http://localhost:3002 with hot reload.

### 4. Run Frontend Locally

```bash
cd frontend
npm install
npm run dev
```

Frontend will run on http://localhost:3000 with hot reload.

## Environment Variables

### Backend (.env)

Key variables you need to configure:

```env
# Database
DATABASE_URL=postgresql://boxmeout:boxmeout@localhost:5432/boxmeout

# Redis
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK=testnet

# Contracts
FACTORY_CONTRACT_ADDRESS=<deployed-contract-address>

# Secrets (CHANGE IN PRODUCTION!)
JWT_SECRET=change-me-in-production
ADMIN_JWT_SECRET=change-me-in-production
ORACLE_PRIVATE_KEY=<your-stellar-secret-key>

# API
PORT=3001
NODE_ENV=development
LOG_LEVEL=info

# CORS (comma-separated origins)
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001

# Email (optional)
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=you@example.com
SMTP_PASS=your-password
SMTP_FROM=no-reply@boxmeout.app
```

### Indexer (.env)

```env
# Port
PORT=3002

# Stellar Network
HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK=testnet

# Contract
FACTORY_CONTRACT_ADDRESS=<deployed-contract-address>

# Database (SQLite for indexer)
DB_PATH=./data/indexer.db
```

### Frontend (.env)

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:3001
NEXT_PUBLIC_STELLAR_NETWORK=testnet
```

## Docker Compose Commands

### Start All Services
```bash
docker compose up
```

### Start Specific Services
```bash
docker compose up postgres redis
docker compose up backend frontend
docker compose up indexer
```

### Stop All Services
```bash
docker compose down
```

### Stop and Remove Volumes (Clean Slate)
```bash
docker compose down -v
```

### View Logs
```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f indexer
```

### Rebuild Services (After Code Changes)
```bash
docker compose up --build
```

### Rebuild Specific Service
```bash
docker compose up --build backend
```

## Database Setup

### Run Migrations (Backend)

```bash
# Inside Docker container
docker compose exec backend npm run migrate

# Or locally
cd backend
npm run migrate
```

### Access PostgreSQL

```bash
# Via Docker
docker compose exec postgres psql -U boxmeout -d boxmeout

# Or locally
psql -h localhost -U boxmeout -d boxmeout
```

### Reset Database

```bash
docker compose down -v
docker compose up postgres -d
# Wait a few seconds for postgres to start
docker compose exec backend npm run migrate
```

## Troubleshooting

### Services Won't Start

**Check logs:**
```bash
docker compose logs backend
docker compose logs indexer
```

**Common issues:**
- `.env` files missing or misconfigured
- Port conflicts (3000, 3001, 3002 already in use)
- Docker out of disk space

### Backend Can't Connect to Database

**Check postgres is healthy:**
```bash
docker compose ps postgres
```

**Verify database credentials:**
```bash
docker compose exec postgres psql -U boxmeout -d boxmeout -c '\l'
```

### Port Already in Use

If ports 3000-3002 are taken, edit `docker-compose.yml`:

```yaml
services:
  backend:
    ports:
      - '3011:3001'  # External:Internal
```

### Rebuild After Package Changes

If you modify `package.json` or `package-lock.json`:

```bash
docker compose down
docker compose up --build
```

## Testing

### Run Backend Tests

```bash
# Inside Docker
docker compose exec backend npm test

# Or locally
cd backend
npm test
```

### Run Indexer Tests

```bash
# Inside Docker
docker compose exec indexer npm test

# Or locally
cd indexer
npm test
```

### Run Integration Tests

```bash
cd backend
npm run test:integration
```

## Contract Deployment (Optional)

If you need to deploy smart contracts:

### 1. Install Dependencies

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Stellar CLI
cargo install stellar-cli
```

### 2. Build Contracts

```bash
cd contracts
cargo build --workspace
```

### 3. Deploy to Testnet

```bash
export ADMIN_SECRET_KEY=S...  # Your Stellar secret key
./scripts/deploy.sh testnet
```

### 4. Update Environment Files

After deployment, update `FACTORY_CONTRACT_ADDRESS` in:
- `backend/.env`
- `indexer/.env`

## Production Deployment

See [docs/DEPLOYMENT.md](./DEPLOYMENT.md) for production deployment guide.

## Architecture Overview

```
┌─────────────┐
│  Frontend   │ :3000
│  (Next.js)  │
└──────┬──────┘
       │
       │ HTTP
       ▼
┌─────────────┐     ┌──────────┐
│   Backend   │────▶│ Postgres │ :5432
│   (API)     │ :3001│          │
└──────┬──────┘     └──────────┘
       │
       │ Cache
       ▼
┌─────────────┐
│    Redis    │ :6379
└─────────────┘

┌─────────────┐     ┌──────────────────┐
│   Indexer   │────▶│ Stellar Horizon  │
│  (Events)   │ :3002│   (Testnet)      │
└──────┬──────┘     └──────────────────┘
       │
       │ Events
       ▼
┌─────────────┐
│  Postgres   │
└─────────────┘
```

## Next Steps

1. ✅ Get the stack running with `docker compose up`
2. 📖 Read [API Documentation](./api-rate-limits.md)
3. 🏗️ Review [Architecture Overview](./architecture.md)
4. 🚀 Deploy contracts (see [Contract Deployment](#contract-deployment-optional))
5. 🧪 Run tests to verify everything works
6. 🔧 Start building!

## Additional Documentation

- [API Rate Limits](./api-rate-limits.md)
- [Architecture Overview](./architecture.md)
- [Observability Guide](./observability.md)
- [Operational Runbook](./runbook.md)
- [Contributing Guidelines](./contributing.md)
- [Email Verification Feature](./QUICK_START.md)

## Support

- **Issues**: https://github.com/your-org/boxmeout/issues
- **Discussions**: https://github.com/your-org/boxmeout/discussions

## Summary

✅ **One command to start**: `docker compose up`
✅ **Full stack ready**: Postgres, Redis, Indexer, Backend, Frontend
✅ **Development mode**: Run services locally with hot reload
✅ **Production ready**: Docker-based deployment
✅ **Well documented**: Comprehensive guides and troubleshooting
