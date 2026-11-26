#!/bin/bash
set -e

echo "=== Docker Compose Verification Test ==="
echo

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Validate docker-compose configuration
echo -e "${YELLOW}[Test 1]${NC} Validating docker-compose configuration..."
if docker-compose config > /dev/null 2>&1; then
  echo -e "${GREEN}✓${NC} docker-compose.yml is valid"
else
  echo -e "${RED}✗${NC} docker-compose.yml validation failed"
  exit 1
fi
echo

# Test 2: Check all required services exist
echo -e "${YELLOW}[Test 2]${NC} Checking required services..."
REQUIRED_SERVICES=("postgres" "redis" "backend" "indexer" "frontend")
for service in "${REQUIRED_SERVICES[@]}"; do
  if docker-compose config | grep -q "^services:" && docker-compose config | grep -q "^  $service:"; then
    echo -e "${GREEN}✓${NC} Service '$service' defined"
  else
    echo -e "${RED}✗${NC} Service '$service' not found"
    exit 1
  fi
done
echo

# Test 3: Verify postgres has health check
echo -e "${YELLOW}[Test 3]${NC} Verifying PostgreSQL health check..."
if grep -q "pg_isready" docker-compose.yml; then
  echo -e "${GREEN}✓${NC} PostgreSQL health check configured"
else
  echo -e "${RED}✗${NC} PostgreSQL health check not found"
  exit 1
fi
echo

# Test 4: Verify redis has health check
echo -e "${YELLOW}[Test 4]${NC} Verifying Redis health check..."
if grep -q "redis-cli" docker-compose.yml; then
  echo -e "${GREEN}✓${NC} Redis health check configured"
else
  echo -e "${RED}✗${NC} Redis health check not found"
  exit 1
fi
echo

# Test 5: Verify backend has health check
echo -e "${YELLOW}[Test 5]${NC} Verifying backend health check..."
if grep -q "localhost:3001/health" docker-compose.yml; then
  echo -e "${GREEN}✓${NC} Backend health check configured"
else
  echo -e "${RED}✗${NC} Backend health check not found"
  exit 1
fi
echo

# Test 6: Verify backend depends on postgres and redis being healthy
echo -e "${YELLOW}[Test 6]${NC} Verifying backend dependencies..."
if grep -A 15 "^  backend:" docker-compose.yml | grep -q "service_healthy" && \
   grep -A 15 "^  backend:" docker-compose.yml | grep -q "postgres:" && \
   grep -A 15 "^  backend:" docker-compose.yml | grep -q "redis:"; then
  echo -e "${GREEN}✓${NC} Backend correctly depends on healthy postgres and redis"
else
  echo -e "${RED}✗${NC} Backend dependency configuration incorrect"
  exit 1
fi
echo

# Test 7: Verify environment variables are set for database connection
echo -e "${YELLOW}[Test 7]${NC} Verifying backend environment variables..."
if grep -A 20 "^  backend:" docker-compose.yml | grep -q "DATABASE_URL" && \
   grep -A 20 "^  backend:" docker-compose.yml | grep -q "REDIS_URL"; then
  echo -e "${GREEN}✓${NC} Backend environment variables configured"
else
  echo -e "${RED}✗${NC} Backend environment variables not properly set"
  exit 1
fi
echo

# Test 8: Verify .env files exist
echo -e "${YELLOW}[Test 8]${NC} Verifying .env files..."
ENV_FILES=("backend/.env" "frontend/.env" "indexer/.env")
for env_file in "${ENV_FILES[@]}"; do
  if [ -f "$env_file" ]; then
    echo -e "${GREEN}✓${NC} $env_file exists"
  else
    echo -e "${RED}✗${NC} $env_file not found"
    exit 1
  fi
done
echo

# Test 9: Verify backend Dockerfile builds TypeScript
echo -e "${YELLOW}[Test 9]${NC} Verifying backend Dockerfile..."
if grep -q "npm run build:prod" backend/Dockerfile; then
  echo -e "${GREEN}✓${NC} Backend Dockerfile compiles TypeScript"
else
  echo -e "${RED}✗${NC} Backend Dockerfile doesn't compile TypeScript"
  exit 1
fi
echo

# Test 10: Verify volumes are defined
echo -e "${YELLOW}[Test 10]${NC} Verifying volumes..."
if grep -q "postgres_data:" docker-compose.yml && \
   grep -q "indexer_data:" docker-compose.yml && \
   grep -q "backend_node_modules:" docker-compose.yml; then
  echo -e "${GREEN}✓${NC} All required volumes defined"
else
  echo -e "${RED}✗${NC} Some volumes are missing"
  exit 1
fi
echo

echo -e "${GREEN}=== All tests passed! ===${NC}"
echo
echo "Next steps:"
echo "1. Run: docker-compose build"
echo "2. Run: docker-compose up"
echo "3. Monitor with: docker-compose logs -f backend"
echo "4. Check health: curl http://localhost:3001/health"
