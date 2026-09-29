#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/verify-wasm-upload.sh"

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

printf 'test wasm payload\n' > "${TEST_DIR}/market.wasm"
EXPECTED_WASM_HASH="$(sha256sum "${TEST_DIR}/market.wasm" | awk '{print $1}')"
WASM_FETCH_SOURCE="${TEST_DIR}/market.wasm"

stellar() {
    local output_file=""

    if [[ "$1" != "contract" || "$2" != "fetch" ]]; then
        return 2
    fi
    shift 2

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --out-file)
                output_file="$2"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    [[ -n "$output_file" ]] || return 2
    cp "$WASM_FETCH_SOURCE" "$output_file"
}

verify_wasm_upload "$EXPECTED_WASM_HASH" "testnet" "http://localhost:8000"

if verify_wasm_upload "0000000000000000000000000000000000000000000000000000000000000000" "testnet" "http://localhost:8000"; then
    echo "ERROR: Mismatched WASM hash was accepted" >&2
    exit 1
fi

echo "WASM upload verification tests passed"