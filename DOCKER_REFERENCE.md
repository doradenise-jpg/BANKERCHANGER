# Docker Reference Guide

Quick reference for common Docker and docker-compose commands.

## Common Commands

### Build & Start

```bash
# Build all images
docker-compose build

# Start all services
docker-compose up

# Build and start (combined)
docker-compose up --build

# Start in background (detached)
docker-compose up -d

# Rebuild specific service
docker-compose build backend
```

### Monitor & Debug

```bash
# View all services status
docker-compose ps

# View service logs (last 50 lines)
docker-compose logs backend --tail=50

# Follow logs in real-time
docker-compose logs -f backend

# View all logs
docker-compose logs -f

# View specific time range
docker-compose logs backend --since 5m

# Display logs with timestamps
docker-compose logs -t backend
```

### Execute Commands

```bash
# Run command in service
docker-compose exec backend npm run migrate

# Open shell in service
docker-compose exec backend sh

# Access database
docker-compose exec postgres psql -U bankerchanger -d bankerchanger

# Access Redis
docker-compose exec redis redis-cli

# Run migrations
docker-compose exec backend npm run migrate:up

# Check migration status
docker-compose exec backend npm run migrate:check
```

### Health Checks

```bash
# Check all services
docker-compose ps
# Shows STATUS column with "(healthy)" when ready

# Manual health check
curl http://localhost:3001/health

# Response on success:
# {"status":"healthy","timestamp":"2024-11-24T..."}

# Response on failure:
# HTTP 503 Service Unavailable
```

### Stop & Clean

```bash
# Stop services (keeps data)
docker-compose stop

# Remove containers (keeps data)
docker-compose down

# Remove everything including volumes (destructive)
docker-compose down -v

# Remove specific service
docker-compose stop backend
docker-compose rm backend

# Full system cleanup
docker system prune -f
```

### Restart Services

```bash
# Restart all
docker-compose restart

# Restart specific service
docker-compose restart backend

# Stop and start (clean restart)
docker-compose stop backend
docker-compose start backend

# Rebuild and restart
docker-compose build backend
docker-compose up -d backend
```

## Service Access

### URLs

```
Frontend:    http://localhost:3000
Backend:     http://localhost:3001
API Docs:    http://localhost:3001/docs
Indexer:     http://localhost:3002
Database:    localhost:5432
Redis:       localhost:6379
```

### Direct Service Access

```bash
# From localhost
curl http://localhost:3001/health

# From within Docker network
docker-compose exec backend curl http://backend:3001/health

# Check all services from backend
docker-compose exec backend curl http://postgres:5432
docker-compose exec backend curl http://redis:6379
```

## Configuration Files

### Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Main configuration |
| `backend/Dockerfile` | Backend build |
| `backend/.env` | Backend config |
| `frontend/.env` | Frontend config |
| `indexer/.env` | Indexer config |

### Environment Variables

#### Backend (.env)

```
# Database
DATABASE_URL=postgresql://bankerchanger:bankerchanger@postgres:5432/bankerchanger

# Redis
REDIS_URL=redis://redis:6379

# Server
PORT=3001
NODE_ENV=development
```

#### Frontend (.env)

```
# API
NEXT_PUBLIC_API_URL=http://localhost:3001

# Stellar Network
NEXT_PUBLIC_STELLAR_NETWORK=testnet
```

## Troubleshooting Commands

### Check System Resources

```bash
# Docker disk usage
docker system df

# Container resource usage
docker stats

# Specific container memory
docker inspect <container_id> | grep -i memory
```

### View Configuration

```bash
# Full docker-compose configuration
docker-compose config

# Just services section
docker-compose config | grep -A 5 "services:"

# Check specific service
docker-compose config | grep -A 20 "backend:"
```

### Network Inspection

```bash
# List networks
docker network ls

# Inspect network
docker network inspect bankerchanger

# Test DNS resolution
docker-compose exec backend nslookup postgres
docker-compose exec backend nslookup redis
```

### Volume Inspection

```bash
# List volumes
docker volume ls

# Inspect volume
docker volume inspect bankerchanger_postgres_data

# Check volume mount
docker inspect <container_id> | grep -A 5 Mounts
```

### Service Status

```bash
# Health of all services
docker-compose ps

# Detailed service info
docker-compose exec backend env | sort

# Check if port is accessible
docker-compose exec backend wget -O- http://localhost:3001/health

# Check database connection
docker-compose exec backend node -e "
  const { Pool } = require('pg');
  const pool = new Pool({connectionString: process.env.DATABASE_URL});
  pool.query('SELECT 1')
    .then(() => console.log('DB OK'))
    .catch(e => console.error('DB ERROR:', e.message))
"
```

## Development Workflow

### Local Development Setup

```bash
# Option 1: Use Docker for dependencies only
docker-compose up postgres redis

# Then run backend locally
cd backend
npm install
npm run dev

# Option 2: Use Docker for everything
docker-compose up --build
```

### After Code Changes

```bash
# TypeScript changes in backend
docker-compose build backend
docker-compose up -d backend
docker-compose logs -f backend

# Frontend changes
docker-compose build frontend
docker-compose up -d frontend

# Database migrations
docker-compose exec backend npm run migrate
```

### View Changes

```bash
# See what changed in image
docker diff <container_id>

# Compare to original image
docker inspect <image_id>
```

## Performance Commands

### Optimize Image Size

```bash
# View image layers
docker history <image_name>

# View image size
docker images | grep bankerchanger
```

### Clean Up

```bash
# Remove unused images
docker image prune -f

# Remove unused volumes
docker volume prune -f

# Remove unused networks
docker network prune -f

# Full cleanup
docker system prune -f -a
```

### Build Optimization

```bash
# Use BuildKit (faster)
DOCKER_BUILDKIT=1 docker-compose build

# No cache (clean build)
docker-compose build --no-cache

# Specific service no cache
docker-compose build --no-cache backend
```

## Production Commands

### Deploy

```bash
# Using specific profile
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# With environment file
docker-compose --env-file .env.prod up -d
```

### Backup Database

```bash
# Backup PostgreSQL
docker-compose exec postgres pg_dump -U bankerchanger bankerchanger > backup.sql

# Restore from backup
docker-compose exec -T postgres psql -U bankerchanger bankerchanger < backup.sql
```

### Monitor Production

```bash
# View logs (last 100 lines)
docker-compose logs --tail=100 backend

# Real-time logs with filter
docker-compose logs -f backend | grep ERROR

# Log metrics
docker stats --no-stream
```

## Verification Commands

### Full System Check

```bash
# Run verification script
bash docker-compose-test.sh

# Validate docker-compose syntax
docker-compose config > /dev/null && echo "Valid"

# Check all services started
docker-compose ps | grep -c "Up"

# Count healthy services
docker-compose ps | grep -c healthy
```

### Endpoint Testing

```bash
# Backend health
curl -s http://localhost:3001/health | jq .

# Backend detailed health (requires admin JWT)
curl -s http://localhost:3001/health/detailed

# Frontend
curl -s http://localhost:3000 | head -20

# API endpoint example
curl -s http://localhost:3001/api/stats | jq .
```

## Common Issues & Solutions

### Port Already in Use

```bash
# Find process using port
lsof -i :3001

# Kill process
kill -9 <PID>

# Or change port in docker-compose.yml
```

### Container Won't Start

```bash
# View full logs
docker-compose logs backend

# Check resource limits
docker stats

# Try rebuilding
docker-compose build --no-cache backend
docker-compose up backend
```

### Database Connection Failed

```bash
# Check PostgreSQL is healthy
docker-compose ps | grep postgres

# Test connection manually
docker-compose exec postgres psql -U bankerchanger -c "SELECT 1"

# Check environment variable
docker-compose exec backend env | grep DATABASE_URL
```

### Volume Permission Issues

```bash
# Fix permissions (Linux)
docker-compose exec postgres chown -R postgres:postgres /var/lib/postgresql/data

# View volume info
docker volume inspect bankerchanger_postgres_data
```

## Quick Recipes

### Reset Everything

```bash
# Full reset (WARNING: deletes all data)
docker-compose down -v
docker system prune -f -a
docker-compose build --no-cache
docker-compose up
```

### Database Dump & Restore

```bash
# Dump
docker-compose exec postgres pg_dump -U bankerchanger bankerchanger | gzip > db.sql.gz

# Restore
zcat db.sql.gz | docker-compose exec -T postgres psql -U bankerchanger bankerchanger
```

### Batch Commands

```bash
# Restart all services
docker-compose down && docker-compose up -d

# Rebuild and restart all
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d

# View all logs at once
docker-compose logs backend frontend postgres redis indexer
```

### Monitoring Dashboard

```bash
# Real-time monitoring
watch -n 1 'docker-compose ps'

# or

# Continuous logs with colors
docker-compose logs -f --colors
```

## Tips & Tricks

### Speed Up Development

```bash
# Keep services running, only rebuild backend
docker-compose up -d postgres redis
docker-compose build backend
npm run dev  # Run locally instead of in Docker

# When you're ready to test in Docker
docker-compose up backend
```

### Debug Service Startup

```bash
# Step through startup
docker-compose build backend
docker-compose run --rm backend /bin/sh

# Inside container:
npm run build:prod
node dist/index.js
```

### View Real-time Metrics

```bash
# CPU and memory
docker stats

# Network I/O
docker-compose exec backend sh -c "netstat -an | grep ESTABLISHED"
```

## Reference Links

- [Docker Compose CLI Reference](https://docs.docker.com/compose/reference/)
- [Docker CLI Reference](https://docs.docker.com/engine/reference/commandline/docker/)
- [Troubleshooting Guide](./DOCKER_SETUP.md#troubleshooting)
- [Quick Start](./QUICK_START_DOCKER.md)
