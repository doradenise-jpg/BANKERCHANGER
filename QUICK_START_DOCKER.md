# Quick Start - Docker Compose

Get the entire BANKERCHANGER stack running in minutes.

## One-Command Start

```bash
# Navigate to project root
cd /workspaces/BANKERCHANGER

# Build and start all services
docker-compose up --build
```

Done! The stack will start with proper dependency ordering:

1. PostgreSQL and Redis start first
2. Backend waits for both databases to be healthy
3. Indexer waits for backend
4. Frontend waits for backend

## Access the Services

Once all services show as healthy:

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001
- **API Docs**: http://localhost:3001/docs (Swagger UI)
- **Indexer**: http://localhost:3002
- **Health Check**: http://localhost:3001/health

## Verify Everything Started

```bash
# Check all services
docker-compose ps

# Should show (after ~1-2 minutes):
# NAME        STATUS
# postgres    Up (healthy)
# redis       Up (healthy)
# backend     Up (healthy)
# indexer     Up (healthy)
# frontend    Up (healthy)
```

## Monitor Logs

```bash
# All services
docker-compose logs -f

# Just backend
docker-compose logs -f backend

# Follow specific service startup
docker-compose logs -f backend --tail=50
```

## Stop the Stack

```bash
# Stop (keeps data)
docker-compose stop

# Remove containers (keeps data)
docker-compose down

# Remove everything including database
docker-compose down -v
```

## If Something Goes Wrong

### Backend won't start

Check if databases are healthy:
```bash
docker-compose ps  # Look for "healthy" status
```

View backend logs:
```bash
docker-compose logs backend | tail -50
```

### Port already in use

Edit `docker-compose.yml` and change the port mapping:
```yaml
backend:
  ports:
    - '3001:3001'  # Change left number to 3010:3001
```

### Database connection errors

Verify `.env` files exist:
```bash
ls -la backend/.env frontend/.env indexer/.env
```

### Full reset

```bash
docker-compose down -v
docker system prune -f
docker-compose build --no-cache
docker-compose up
```

## Development Tips

### Rebuild after code changes

```bash
# Just rebuild backend
docker-compose build backend

# Restart it
docker-compose up -d backend

# View logs
docker-compose logs -f backend
```

### Access container shell

```bash
# Backend shell
docker-compose exec backend sh

# Postgres shell
docker-compose exec postgres psql -U bankerchanger

# Redis shell
docker-compose exec redis redis-cli
```

### Run migrations

```bash
docker-compose exec backend npm run migrate
```

### View database

```bash
docker-compose exec postgres psql -U bankerchanger -d bankerchanger
```

## Expected Startup Timeline

```
[postgres]  Starting... ✓ Healthy (10-15s)
[redis]     Starting... ✓ Healthy (5-10s)
[backend]   Waiting for DB & Redis... ✓ Healthy (20-30s)
[indexer]   Waiting for backend... ✓ Healthy (20-30s)
[frontend]  Waiting for backend... ✓ Healthy (30-45s)

Total startup time: ~2-3 minutes
```

## Verification

Run the test script to verify everything is configured correctly:

```bash
bash docker-compose-test.sh
```

All tests should pass ✓

## Next Steps

1. Access the frontend: http://localhost:3000
2. Check API docs: http://localhost:3001/docs
3. Run integration tests: `docker-compose exec backend npm run test:integration`
4. Check logs: `docker-compose logs -f`

## Key Files

- `docker-compose.yml` - Service configuration
- `backend/Dockerfile` - Backend build (TypeScript compilation)
- `backend/.env` - Backend configuration
- `frontend/.env` - Frontend configuration
- `indexer/.env` - Indexer configuration
- `DOCKER_SETUP.md` - Full documentation

## Support

See `DOCKER_SETUP.md` for detailed troubleshooting and advanced configuration.
