# Fix: Indexer Environment Variable and Docker Compose Configuration

## Problem

The indexer (`indexer/src/poller.ts`) had three critical issues:

1. **Wrong Environment Variable**: Used `INVOICE_CONTRACT_ID` (from a different project) instead of `FACTORY_CONTRACT_ADDRESS`
2. **Silent Failure**: Had a mock fallback `'C_MOCK_INVOICE_CONTRACT_ID'` that masked configuration errors
3. **Missing Docker Service**: No indexer service in docker-compose.yml, so indexer wasn't deployed
4. **No Dockerfile**: Indexer couldn't be built/containerized

### Consequences

- Indexer silently polled a non-existent contract address
- No events were indexed
- No market events reached the backend
- Users couldn't see market updates

## Solution

### 1. Renamed Environment Variable (`indexer/src/poller.ts`)

**Before:**
```typescript
const CONTRACT_ID = process.env.INVOICE_CONTRACT_ID || 'C_MOCK_INVOICE_CONTRACT_ID';
```

**After:**
```typescript
const CONTRACT_ID = process.env.FACTORY_CONTRACT_ADDRESS;

if (!CONTRACT_ID) {
  throw new Error('FACTORY_CONTRACT_ADDRESS environment variable is not set. Cannot initialize indexer.');
}
```

**Changes:**
- ✓ Renamed to `FACTORY_CONTRACT_ADDRESS` (matches backend config)
- ✓ Removed mock fallback
- ✓ Fail fast with clear error message if not set

### 2. Added Indexer to Docker Compose (`docker-compose.yml`)

**Added new service:**
```yaml
  indexer:
    build: ./indexer
    restart: unless-stopped
    depends_on:
      - backend
    env_file: ./backend/.env
    environment:
      - FACTORY_CONTRACT_ADDRESS=${FACTORY_CONTRACT_ADDRESS}
      - SOROBAN_RPC_URL=${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}
    volumes:
      - indexer_data:/app/data
```

**Features:**
- ✓ Builds from `./indexer` Dockerfile
- ✓ Depends on backend (ensures backend env vars are loaded)
- ✓ Loads backend .env file
- ✓ Passes FACTORY_CONTRACT_ADDRESS explicitly
- ✓ Maps STELLAR_RPC_URL to SOROBAN_RPC_URL with fallback
- ✓ Persists SQLite data in volume

**Added volume:**
```yaml
volumes:
  postgres_data:
  indexer_data:  # New: for indexer SQLite database
```

### 3. Created Dockerfile for Indexer (`indexer/Dockerfile`)

Multi-stage build with:
- ✓ Build stage: Compile TypeScript
- ✓ Runtime stage: Minimal Node image with production dependencies
- ✓ Data directory creation for SQLite
- ✓ Health check endpoint support
- ✓ Signal handling with dumb-init

## Configuration

### Backend .env Requirements

Must include:
```bash
FACTORY_CONTRACT_ADDRESS=C...  # Required by indexer
STELLAR_RPC_URL=...            # Used as SOROBAN_RPC_URL fallback
```

### Docker Compose Startup

```bash
# Build all services including indexer
docker-compose build

# Start all services
docker-compose up

# The indexer will:
# 1. Connect to Soroban RPC
# 2. Poll FACTORY_CONTRACT_ADDRESS for events
# 3. Store events in SQLite database
# 4. Persist data in indexer_data volume
```

## Impact

- ✓ Indexer now uses correct contract address
- ✓ Fails fast if FACTORY_CONTRACT_ADDRESS is not set
- ✓ Indexer can be deployed via Docker Compose
- ✓ Event indexing will work correctly
- ✓ Market events propagate to backend

## Files Modified

1. `indexer/src/poller.ts` – Environment variable fix
2. `docker-compose.yml` – Added indexer service and volume
3. `indexer/Dockerfile` – NEW: Docker build configuration

## Verification

```bash
# Check indexer is running
docker-compose logs indexer

# Should see:
# indexer_1 | Started polling Horizon for contract events...

# Check environment
docker-compose exec indexer env | grep FACTORY_CONTRACT_ADDRESS

# Should output the actual contract address, not C_MOCK_INVOICE_CONTRACT_ID
```

---

**Status**: ✅ Fixed. Indexer will now properly index events from the factory contract.
