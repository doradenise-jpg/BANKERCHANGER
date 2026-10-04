verify_wasm_upload() {
    local expected_hash="$1"
    local network="$2"
    local rpc_url="$3"
    local fetched_wasm
    local fetched_hash

    if [[ ! "$expected_hash" =~ ^[a-f0-9]{64}$ ]]; then
        echo "ERROR: Invalid expected WASM hash '$expected_hash'" >&2
        return 1
    fi

    fetched_wasm="$(mktemp)"
    if ! SOROBAN_RPC_URL="$rpc_url" stellar contract fetch \
        --wasm-hash "$expected_hash" \
        --out-file "$fetched_wasm" \
        --network "$network"; then
        rm -f "$fetched_wasm"
        echo "ERROR: Could not fetch uploaded WASM for hash $expected_hash" >&2
        return 1
    fi

    if ! fetched_hash="$(sha256sum "$fetched_wasm" | awk '{print $1}')"; then
        rm -f "$fetched_wasm"
        echo "ERROR: Could not compute SHA-256 for fetched WASM" >&2
        return 1
    fi
    rm -f "$fetched_wasm"

    if [[ "$fetched_hash" != "$expected_hash" ]]; then
        echo "ERROR: Uploaded WASM hash mismatch (expected $expected_hash, fetched $fetched_hash)" >&2
        return 1
    fi

    echo "  Verified uploaded Market wasm hash: $fetched_hash"
}