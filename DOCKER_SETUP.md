# Docker Compose Setup Guide

This document describes the Docker Compose configuration for BANKERCHANGER, including all services, health checks, and dependency management.

## Overview

The Docker Compose setup includes five services that work together:

- **PostgreSQL** - Primary database (port 5432)
- **Redis** - Caching and session store (port 6379)
- **Backend** - Express.js TypeScript API (port 3001)
- **Indexer** - Stellar ledger indexer (port 3002)
- **Frontend** - Next.js React application (port 3000)

## Service Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend (3000)                     │
│                 (depends on Backend health)              │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                      Backend (3001)                      │
│          (depends on Postgres & Redis health)           │
└────────────────────────┬────────────────────────────────┘
                    ┌────┴────┐
                    ▼         ▼
        ┌──────────────┐  ┌──────────────┐
        │  Postgres    │  │    Redis     │
        │   (5432)     │  │   (6379)     │
        │   (health)   │  │   (health)   │
        └──────────────┘  └──────────────┘
                    │
                    ▼
        ┌──────────────────────┐
        │     Indexer (3002)   │
        │  (depends on Backend  │
        │      health)         │
        └──────────────────────┘
```

## Health Checks

Each service has a health check configured to ensure it starts properly before dependent services begin.

### PostgreSQL Health Check

```yaml
healthcheck:
  test: ['CMD-SHELL', 'pg_isready -U bankerchanger']
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 10s
```

Returns healthy when PostgreSQL is ready to accept connections.

### Redis Health Check

```yaml
healthcheck:
  test: ['CMD', 'redis-cli', 'ping']
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 10s
```

Returns healthy when Redis responds to PING.

### Backend Health Check

```yaml
healthcheck:
  test: ['CMD', 'node', '-e', "require('http').get('http://localhost:3001/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"]
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 30s
```

Calls the `/health` endpoint and verifies it returns HTTP 200. This endpoint confirms both database and Redis connectivity.

**Backend /health endpoint:**
- Located in: `backend/src/index.ts`
- Returns: `{ status: "healthy", timestamp: "ISO timestamp" }`
- Checks: PostgreSQL connectivity and Redis connectivity

### Indexer Health Check

```yaml
healthcheck:
  test: ['CMD', 'wget', '--quiet', '--tries=1', '--spider', 'http://localhost:3002/health']
  interval: 10s
  timeout: 5s
  retries: 5
  start_period: 30s
```

Checks for a 200 response from the indexer's `/health` endpoint.

## Dependency Management

Services start in order of their dependencies:

1. **PostgreSQL** and **Redis** start immediately (no dependencies)
2. **Backend** waits for both PostgreSQL and Redis to be healthy
3. **Indexer** waits for PostgreSQL, Redis, and Backend to be healthy
4. **Frontend** waits for Backend to be healthy

```
docker-compose up
  ├─ postgres (starts immediately, waits for health check)
  ├─ redis (starts immediately, waits for health check)
  ├─ backend (waits for postgres & redis healthy)
  ├─ indexer (waits for postgres & redis & backend healthy)
  └─ frontend (waits for backend healthy)
```

## Environment Configuration

### Backend Environment (.env files)

**Database Connection**
- `DATABASE_URL=postgresql://bankerchanger:bankerchanger@postgres:5432/bankerchanger`
  - Note: Uses `postgres` hostname (Docker service name), not localhost
- `REDIS_URL=redis://redis:6379`
  - Note: Uses `redis` hostname (Docker service name), not localhost

**Key Configuration Files:**
- `backend/.env` - Backend service environment
- `frontend/.env` - Frontend service environment
- `indexer/.env` - Indexer service environment

All `.env` files are automatically loaded by `docker-compose` via the `env_file` directive.

## Volumes

### Named Volumes

- **postgres_data** - PostgreSQL data persistence across restarts
- **backend_node_modules** - Node modules caching for faster rebuilds
- **indexer_data** - Indexer local database storage

### Volume Benefits

- Persistent storage survives container restarts
- Faster subsequent builds (node_modules cached)
- Database state persists between deployments

## Network

All services connect via the `bankerchanger` bridge network:

```yaml
networks:
  default:
    name: bankerchanger
    driver: bridge
```

This allows services to communicate using their service names as hostnames (e.g., `postgres:5432`, `redis:6379`).

## TypeScript Build Configuration

The backend uses a multi-stage Dockerfile for optimized production builds:

```dockerfile
# Stage 1: Build (includes TypeScript compilation)
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:prod  # Compiles TypeScript to dist/

# Stage 2: Runtime (minimal production image)
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
```

**Benefits:**
- Final image doesn't include TypeScript compiler or source files
- Smaller production image (only runtime dependencies)
- Faster startup time

## Running the Stack

### Prerequisites

- Docker and Docker Compose installed
- `.env` files configured (provided in setup)

### Start All Services

```bash
# Build all images
docker-compose build

# Start all services
docker-compose up

# Start in background (detached mode)
docker-compose up -d
```

### Monitor Services

```bash
# View all logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f backend
docker-compose logs -f postgres
docker-compose logs -f redis

# View real-time service status
docker-compose ps
```

### Health Checks

```bash
# Check all services
docker-compose ps

# Manual health check for backend
curl http://localhost:3001/health

# Response (success):
# {"status":"healthy","timestamp":"2024-11-24T06:00:00.000Z"}

# Response (failure):
# HTTP 503 - Service Unavailable
```

### Stop Services

```bash
# Stop all services (keep data)
docker-compose stop

# Remove all containers (keep data)
docker-compose down

# Remove everything including volumes (destructive)
docker-compose down -v
```

## Development Workflow

### Local Development (without Docker)

```bash
# Start only database services
docker-compose up postgres redis

# In another terminal, run backend locally
cd backend
npm install
npm run dev
```

### Docker Development

```bash
# Start everything in background
docker-compose up -d

# Watch backend logs
docker-compose logs -f backend

# Access services:
# - Frontend: http://localhost:3000
# - Backend: http://localhost:3001
# - Indexer: http://localhost:3002
# - Postgres: localhost:5432
# - Redis: localhost:6379
```

### Rebuilding After Code Changes

```bash
# Rebuild specific service
docker-compose build backend

# Restart service
docker-compose up -d backend

# Or rebuild and restart in one command
docker-compose up -d --build backend
```

## Troubleshooting

### Backend fails to start

1. **Check dependencies are healthy:**
   ```bash
   docker-compose ps
   # Verify postgres and redis show "healthy"
   ```

2. **Check backend logs:**
   ```bash
   docker-compose logs backend
   ```

3. **Verify database connectivity:**
   ```bash
   docker-compose exec backend node -e "
     const { Pool } = require('pg');
     const pool = new Pool({ connectionString: process.env.DATABASE_URL });
     pool.query('SELECT 1')
       .then(() => console.log('DB connected'))
       .catch(e => console.error('DB error:', e))
   "
   ```

### Services take too long to start

Health check timeouts can be extended in `docker-compose.yml`:

```yaml
healthcheck:
  start_period: 60s  # Increase from 30s
  retries: 10        # Increase from 5
```

### Port conflicts

If ports are in use, modify `docker-compose.yml`:

```yaml
backend:
  ports:
    - '3001:3001'  # Change left side: 'HOST:CONTAINER'
```

### Database migrations

```bash
# Run migrations in running container
docker-compose exec backend npm run migrate

# Check migration status
docker-compose exec backend npm run migrate:check
```

### Reset everything

```bash
# Remove all containers, networks, and volumes
docker-compose down -v

# Rebuild everything
docker-compose build --no-cache

# Start fresh
docker-compose up
```

## Performance Optimization

### Build Caching

```bash
# Use --no-cache to skip caching
docker-compose build --no-cache

# Or rebuild specific layer
docker-compose build --no-cache backend
```

### Volume Performance

On macOS/Windows, consider using named volumes for better performance:

```yaml
volumes:
  - backend_node_modules:/app/node_modules  # Already cached
```

### CPU/Memory Limits

Optionally set resource limits in `docker-compose.yml`:

```yaml
backend:
  deploy:
    resources:
      limits:
        cpus: '1'
        memory: 1G
      reservations:
        cpus: '0.5'
        memory: 512M
```

## Production Deployment

For production, consider:

1. **Use specific image tags** instead of `latest`
2. **Enable resource limits** to prevent runaway processes
3. **Configure persistent volumes** in a managed storage system
4. **Set up automated backups** for PostgreSQL
5. **Use environment-specific `.env` files**
6. **Enable Docker Compose profiles** for conditional services

Example production start:

```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Verification Test

Run the included verification script to ensure everything is configured correctly:

```bash
bash docker-compose-test.sh
```

This validates:
- ✓ docker-compose.yml is valid
- ✓ All required services defined
- ✓ Health checks configured
- ✓ Dependencies properly set
- ✓ Environment variables configured
- ✓ .env files exist
- ✓ TypeScript build configured
- ✓ Volumes defined

## References

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Docker Healthchecks](https://docs.docker.com/engine/reference/builder/#healthcheck)
- [PostgreSQL Docker Image](https://hub.docker.com/_/postgres)
- [Redis Docker Image](https://hub.docker.com/_/redis)
- [Node.js Docker Image](https://hub.docker.com/_/node)
