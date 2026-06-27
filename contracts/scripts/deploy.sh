#!/usr/bin/env bash
# ============================================================
# BOXMEOUT — Soroban Contract Deployment Script
#
# Deploys contracts in order: shared (build-only) → treasury
#   → market_factory → market (template wasm upload)
#
# Usage:
#   export ADMIN_SECRET_KEY=S...
#   ./scripts/deploy.sh [testnet|mainnet]
#
# Network Defaults:
#   testnet:  RPC https://soroban-testnet.stellar.org
#             Horizon https://horizon-testnet.stellar.org
#   mainnet:  RPC https://soroban-mainnet.stellar.org
#             Horizon https://horizon.stellar.org
#
# Required env vars:
#   ADMIN_SECRET_KEY   Stellar secret key for contract deployment
#
# Optional env vars:
#   STELLAR_RPC_URL    Custom Soroban RPC endpoint
#   HORIZON_URL        Custom Horizon API endpoint
#   ORACLE_ADDRESSES   Comma-separated oracle Stellar addresses
#   DEFAULT_FEE_BPS    Platform fee in bps (default: 200)
#   WITHDRAWAL_LIMIT   Treasury daily limit in stroops (default: 1000000000)
#
# Examples:
#   ./scripts/deploy.sh testnet
#   STELLAR_RPC_URL=http://localhost:8000 ./scripts/deploy.sh testnet
#   STELLAR_RPC_URL=http://private-rpc:8000 HORIZON_URL=http://private-horizon:8001 ./scripts/deploy.sh mainnet
#
# Output:
#   contracts/deployments.json  — deployed addresses + metadata
# ============================================================

set -euo pipefail

NETWORK="${1:-testnet}"
CONTRACTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${CONTRACTS_DIR}/target/wasm32-unknown-unknown/release"
DEPLOYMENTS_FILE="${CONTRACTS_DIR}/deployments.json"

ADMIN_SECRET_KEY="${ADMIN_SECRET_KEY:-}"
ORACLE_ADDRESSES="${ORACLE_ADDRESSES:-}"
DEFAULT_FEE_BPS="${DEFAULT_FEE_BPS:-200}"
WITHDRAWAL_LIMIT="${WITHDRAWAL_LIMIT:-1000000000}"

# Set RPC and Horizon URLs based on network, allow overrides via env vars
if [[ "$NETWORK" == "testnet" ]]; then
    STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
    HORIZON_URL="${HORIZON_URL:-https://horizon-testnet.stellar.org}"
elif [[ "$NETWORK" == "mainnet" ]]; then
    STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-mainnet.stellar.org}"
    HORIZON_URL="${HORIZON_URL:-https://horizon.stellar.org}"
else
    echo "ERROR: Invalid network '$NETWORK'. Must be 'testnet' or 'mainnet'" >&2
    exit 1
fi

# Validate required environment variables
if [[ -z "$ADMIN_SECRET_KEY" ]]; then
    echo "ERROR: ADMIN_SECRET_KEY is not set" >&2
    echo "Please set the ADMIN_SECRET_KEY environment variable with your Stellar secret key" >&2
    exit 1
fi

if [[ -z "$STELLAR_RPC_URL" ]]; then
    echo "ERROR: STELLAR_RPC_URL is not set" >&2
    echo "Please set STELLAR_RPC_URL or use a valid network (testnet/mainnet)" >&2
    exit 1
fi

if [[ -z "$HORIZON_URL" ]]; then
    echo "ERROR: HORIZON_URL is not set" >&2
    echo "Please set HORIZON_URL or use a valid network (testnet/mainnet)" >&2
    exit 1
fi

echo "Configuration:"
echo "  Network:          $NETWORK"
echo "  RPC URL:          $STELLAR_RPC_URL"
echo "  Horizon URL:      $HORIZON_URL"
echo "  Admin address:    (derived from secret key)"
echo ""

# ── Helpers ──────────────────────────────────────────────────────────────────

stellar_deploy() {
    SOROBAN_RPC_URL="$STELLAR_RPC_URL" \
    stellar contract deploy \
        --wasm "$1" \
        --source "$ADMIN_SECRET_KEY" \
        --network "$NETWORK" 2>&1
}

stellar_invoke() {
    local contract_id="$1"; shift
    SOROBAN_RPC_URL="$STELLAR_RPC_URL" \
    stellar contract invoke \
        --id "$contract_id" \
        --source "$ADMIN_SECRET_KEY" \
        --network "$NETWORK" \
        -- "$@" 2>&1
}

# ── 1. Build all contracts (shared is a library; no deploy needed) ────────────
echo "[1/5] Building workspace..."
cd "$CONTRACTS_DIR"
stellar contract build 2>&1 || cargo build --release --target wasm32-unknown-unknown

# ── 2. Deploy Treasury ────────────────────────────────────────────────────────
echo "[2/5] Deploying Treasury..."
TREASURY_ADDRESS=$(stellar_deploy "${BUILD_DIR}/boxmeout_treasury.wasm" \
    | grep -oE '[A-Z0-9]{56}' | head -1)
[[ -z "$TREASURY_ADDRESS" ]] && { echo "ERROR: Treasury deploy failed" >&2; exit 1; }
echo "  Treasury: $TREASURY_ADDRESS"

ADMIN_ADDRESS=$(SOROBAN_RPC_URL="$STELLAR_RPC_URL" stellar keys address "$ADMIN_SECRET_KEY" --network "$NETWORK" 2>/dev/null \
    || SOROBAN_RPC_URL="$STELLAR_RPC_URL" stellar account info --source "$ADMIN_SECRET_KEY" --network "$NETWORK" \
       | grep -oE '[A-Z0-9]{56}' | head -1)

stellar_invoke "$TREASURY_ADDRESS" initialize \
    --admin "$ADMIN_ADDRESS" \
    --withdrawal-limit "$WITHDRAWAL_LIMIT"
echo "  Treasury initialized"

# ── 3. Deploy MarketFactory ───────────────────────────────────────────────────
echo "[3/5] Deploying MarketFactory..."
MARKET_FACTORY_ADDRESS=$(stellar_deploy "${BUILD_DIR}/boxmeout_market_factory.wasm" \
    | grep -oE '[A-Z0-9]{56}' | head -1)
[[ -z "$MARKET_FACTORY_ADDRESS" ]] && { echo "ERROR: MarketFactory deploy failed" >&2; exit 1; }
echo "  MarketFactory: $MARKET_FACTORY_ADDRESS"

ORACLE_ARGS=()
if [[ -n "$ORACLE_ADDRESSES" ]]; then
    ORACLE_ARGS=(--oracle-addresses "$ORACLE_ADDRESSES")
fi

stellar_invoke "$MARKET_FACTORY_ADDRESS" initialize \
    --admin "$ADMIN_ADDRESS" \
    --default-fee-bps "$DEFAULT_FEE_BPS" \
    "${ORACLE_ARGS[@]+"${ORACLE_ARGS[@]}"}"
echo "  MarketFactory initialized"

# ── 4. Upload Market template wasm (factory deploys instances) ────────────────
echo "[4/5] Uploading Market wasm..."
MARKET_WASM_HASH=$(SOROBAN_RPC_URL="$STELLAR_RPC_URL" stellar contract install \
    --wasm "${BUILD_DIR}/boxmeout_market.wasm" \
    --source "$ADMIN_SECRET_KEY" \
    --network "$NETWORK" 2>&1 | grep -oE '[a-f0-9]{64}' | head -1)
[[ -z "$MARKET_WASM_HASH" ]] && { echo "ERROR: Market wasm upload failed" >&2; exit 1; }
echo "  Market wasm hash: $MARKET_WASM_HASH"

# ── 5. Save deployments.json ──────────────────────────────────────────────────
echo "[5/5] Writing deployments.json..."
DEPLOYED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$DEPLOYMENTS_FILE" <<EOF
{
  "network": "$NETWORK",
  "deployedAt": "$DEPLOYED_AT",
  "contracts": {
    "treasury": {
      "address": "$TREASURY_ADDRESS"
    },
    "marketFactory": {
      "address": "$MARKET_FACTORY_ADDRESS",
      "defaultFeeBps": $DEFAULT_FEE_BPS
    },
    "market": {
      "wasmHash": "$MARKET_WASM_HASH"
    }
  },
  "admin": "$ADMIN_ADDRESS"
}
EOF

echo ""
echo "========================================"
echo "Deployment complete — $NETWORK"
echo "  Treasury:      $TREASURY_ADDRESS"
echo "  MarketFactory: $MARKET_FACTORY_ADDRESS"
echo "  Market wasm:   $MARKET_WASM_HASH"
echo "  Saved to:      $DEPLOYMENTS_FILE"
