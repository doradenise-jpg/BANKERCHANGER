# Development Setup — Hot Reload with Docker Compose

The `docker-compose.override.yml` file enables hot-reload for local development. This file is **automatically excluded from git** and safe for development-only configuration.

## Quick Start (With Hot Reload)

```bash
# Start all services with hot-reload enabled
docker compose up

# Services automatically restart on file changes:
# - Backend:  npm run dev (ts-node-dev)
# - Indexer:  npm run dev (ts-node)
# - Frontend: npm run dev (Next.js)
```

The override file mounts your source code into the containers and runs dev scripts with auto-reload.

## Production Mode (Without Hot Reload)

To run in production mode (no hot-reload):

```bash
# Temporarily disable the override file
mv docker-compose.override.yml docker-compose.override.yml.bak

# Start without hot-reload
docker compose up

# Restore override file when done with production testing
mv docker-compose.override.yml.bak docker-compose.override.yml
```

## How It Works

Docker Compose automatically applies `docker-compose.override.yml` after the base `docker-compose.yml`. The override file:

- Mounts source directories into containers
- Runs `npm run dev` instead of production builds
- Sets `NODE_ENV=development`
- Preserves `/app/node_modules` to avoid conflicts

See: [Docker Compose Multiple Files Documentation](https://docs.docker.com/compose/multiple-compose-files/)

## Development Workflow

### Edit code → Auto-reload
Just edit files in your editor. Services reload automatically:

```bash
# Example: Edit backend/src/index.ts
# → ts-node-dev detects change
# → Backend restarts (~2-3 seconds)
# → API responds with new code
```

### View logs
```bash
# All services
docker compose logs -f

# Single service
docker compose logs -f backend
docker compose logs -f indexer
docker compose logs -f frontend
```

### Stop services
```bash
docker compose down
```

### Restart a specific service
```bash
docker compose restart backend
```

## Troubleshooting

### Hot-reload not working?

1. **Verify override file exists**: `ls docker-compose.override.yml`
2. **Check volume mounts**:
   ```bash
   docker inspect <container-id> | grep -A 20 Mounts
   ```
3. **Restart service**:
   ```bash
   docker compose restart backend
   ```

### npm dependencies not installed?

Hot-reload works for source code, not `package.json` changes. After adding dependencies:

```bash
# Rebuild the image
docker compose build backend

# Or use local dev without Docker (see README.md)
```

### Port conflicts?

If you have local services on 3000, 3001, 3002, or 5432:

```bash
# Find what's using the port (e.g., 3000)
lsof -i :3000

# Stop Docker services and run locally instead
docker compose down
cd backend && npm run dev
cd indexer && npm run dev
cd frontend && npm run dev
```

## Local Development (Without Docker)

If you prefer running services locally:

```bash
# Terminal 1: Database & cache only
docker compose up postgres redis

# Terminal 2: Backend
cd backend && npm install && npm run dev

# Terminal 3: Indexer
cd indexer && npm install && npm run dev

# Terminal 4: Frontend
cd frontend && npm install && npm run dev
```

This avoids Docker overhead and may be faster on some systems.
