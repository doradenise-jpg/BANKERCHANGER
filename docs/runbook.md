# BoxMeOut Operational Runbook

## Overview

This runbook provides step-by-step procedures for responding to common production incidents in the BoxMeOut platform. Each incident type includes observable symptoms, diagnostic procedures, resolution steps, and escalation protocols.

**Table of Contents:**
1. [Oracle Failures & Unresolved Markets](#oracle-failures--unresolved-markets)
2. [Treasury Withdrawal Limits Exceeded](#treasury-withdrawal-limits-exceeded)
3. [Contract Pause Events](#contract-pause-events)
4. [High Dispute Volumes](#high-dispute-volumes)
5. [RPC Node Outages](#rpc-node-outages)
6. [Quick Reference: CLI Commands](#quick-reference-cli-commands)

---

## Oracle Failures & Unresolved Markets

### Observable Symptoms

- Markets stuck in "locked" state beyond expected resolution time
- Oracle provider reports failed submission
- Blockchain explorer shows no resolution transaction for market
- User complaints about inability to claim or receive payouts
- Zero or null `outcome` field in market records after scheduled_at has passed

### Diagnostic Procedures

**Step 1: Verify Market Status**
```bash
# Check market state in database
curl -s http://localhost:3001/api/markets/{market_id} | jq '.status, .outcome, .scheduled_at'

# Expected output should show: status: "locked", outcome: null (if in past)
```

**Step 2: Check Oracle Submission Logs**
```bash
# Query backend logs for resolution attempt
grep "oracle.*submit\|resolution.*failed" backend.log

# Check Horizon for pending transactions
curl -s "https://horizon-testnet.stellar.org/accounts/{oracle_address}/transactions" | jq '.records[0:5]'
```

**Step 3: Verify Contract State**
```bash
# Get market factory state
stellar contract invoke \
    --id {MARKET_FACTORY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network testnet \
    -- query_market \
    --market-id {market_id}
```

### Resolution Steps

**For Recent Oracle Failures (within 1 hour):**

1. **Contact Oracle Provider** - Verify service status and resubmission ETA
2. **Trigger Manual Resolution** (if authorized):
   ```bash
   # Force resolve market to draw (no contest)
   stellar contract invoke \
       --id {MARKET_FACTORY_ADDRESS} \
       --source {ADMIN_SECRET_KEY} \
       --network mainnet \
       -- admin_force_resolve \
       --market-id {market_id} \
       --outcome no_contest
   ```

3. **Notify Users** - Inform affected bettors of forced resolution and payout timing

**For Extended Oracle Downtime (>1 hour):**

1. **Escalate to Oracle Service Provider** - Request emergency support
2. **Prepare Market Cancellation** - See [cancellation CLI commands](#force-cancel-market) below
3. **Refund Treasury Preparation** - Ensure sufficient liquidity for refunds

### Escalation Protocol

- **Level 1 (0-30 min):** Monitor and contact oracle provider support
- **Level 2 (30-60 min):** Notify platform administrators, prepare market force-resolution
- **Level 3 (>1 hour):** Invoke emergency pause, initiate user communications, request oracle emergency support

---

## Treasury Withdrawal Limits Exceeded

### Observable Symptoms

- Withdrawal transactions fail with "limit exceeded" error
- Error logs show: `withdrawal_limit_exceeded` or `daily_limit_exceeded`
- Users unable to claim winnings or withdraw funds
- Database shows total_withdrawn > WITHDRAWAL_LIMIT for current day

### Diagnostic Procedures

**Step 1: Check Current Treasury State**
```bash
# Query treasury contract
stellar contract invoke \
    --id {TREASURY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network testnet \
    -- get_treasury_state

# Check: current_day_withdrawn vs withdrawal_limit_stroops
```

**Step 2: Verify Daily Limit Configuration**
```bash
# Check configured withdrawal limit in deployments.json
jq '.contracts.treasury.withdrawalLimitStroops' contracts/deployments.json

# Convert stroops to XLM (divide by 10,000,000)
echo "scale=7; $(jq '.contracts.treasury.withdrawalLimitStroops' contracts/deployments.json) / 10000000" | bc
```

**Step 3: Analyze Withdrawal Patterns**
```bash
# Query recent withdrawals from backend
curl -s "http://localhost:3001/api/treasury/withdrawals?limit=50&sort=latest" | \
    jq '.withdrawals | group_by(.date) | map({date: .[0].date, total: map(.amount | tonumber) | add})'
```

### Resolution Steps

**Option A: Increase Daily Withdrawal Limit (Recommended)**

1. **Update Treasury Contract:**
   ```bash
   # Invoke update_withdrawal_limit on treasury
   stellar contract invoke \
       --id {TREASURY_ADDRESS} \
       --source {ADMIN_SECRET_KEY} \
       --network mainnet \
       -- update_withdrawal_limit \
       --new-limit-stroops {NEW_LIMIT}
   
   # Example: 2 billion stroops (200 XLM)
   # stellar contract invoke ... --new-limit-stroops 2000000000
   ```

2. **Verify Update:**
   ```bash
   stellar contract invoke \
       --id {TREASURY_ADDRESS} \
       --source {ADMIN_SECRET_KEY} \
       --network mainnet \
       -- get_treasury_state | jq '.withdrawal_limit_stroops'
   ```

3. **Notify Users** - Inform waiting users that withdrawals are now available

**Option B: Wait for Daily Reset**

1. If the spike is temporary, daily limits reset at UTC midnight
2. Provide ETA to users: "Withdrawals available at 00:00 UTC tomorrow"
3. Monitor for continued issues

**Option C: Temporary Emergency Pause (if security concern)**

See [Contract Pause Events](#contract-pause-events) section.

### Escalation Protocol

- **Level 1:** Analyze withdrawal patterns, increase limit if stable
- **Level 2 (Repeated in 24h):** Notify analytics team, review fee structure impact
- **Level 3 (Pattern suggests fraud):** Pause treasury, investigate, escalate to security team

---

## Contract Pause Events

### Observable Symptoms

- Market creation returns "contract paused" error
- Bet placement fails with pause/freeze status
- All contract invocations fail or are blocked
- User-facing UI shows maintenance message

### Diagnostic Procedures

**Step 1: Check Pause Status**
```bash
# Query market factory pause state
stellar contract invoke \
    --id {MARKET_FACTORY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network testnet \
    -- is_paused

# Returns: true/false
```

**Step 2: Identify Pause Reason**
```bash
# Check recent contract logs
grep "pause\|frozen\|emergency" backend.log | tail -20

# Check for recent admin operations
stellar contract invoke \
    --id {MARKET_FACTORY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network testnet \
    -- get_pause_reason
```

**Step 3: Estimate Impact**
```bash
# Count locked markets
curl -s http://localhost:3001/api/markets?status=locked | jq '.total'

# Check pending withdrawals
curl -s http://localhost:3001/api/treasury/pending_withdrawals | jq '.total_pending_stroops'
```

### Resolution Steps

**For Intentional Pause (maintenance/security):**

1. **Verify Admin Authorization:**
   ```bash
   # Check transaction history for pause event
   stellar transaction {PAUSE_TX_HASH} --network mainnet
   ```

2. **Communicate Timeline:**
   - Notify users via all channels
   - Provide estimated resume time
   - Monitor for support requests

3. **Resume Operations:**
   ```bash
   # Unpause market factory
   stellar contract invoke \
       --id {MARKET_FACTORY_ADDRESS} \
       --source {ADMIN_SECRET_KEY} \
       --network mainnet \
       -- admin_unpause
   ```

4. **Verify Resumption:**
   ```bash
   stellar contract invoke \
       --id {MARKET_FACTORY_ADDRESS} \
       --source {ADMIN_SECRET_KEY} \
       --network mainnet \
       -- is_paused

   # Should return: false
   ```

**For Unintended Pause:**

1. **Identify cause** - Check logs for error triggers
2. **Assess risk** - Is there active fraud or exploit?
3. **Unpause immediately** if false alarm using command above
4. **Post-mortem** - Review what triggered pause

### Escalation Protocol

- **Level 1:** Confirm pause reason, communicate ETA
- **Level 2:** Notify platform leads, analyze impact
- **Level 3:** Executive notification if >1 hour outage

---

## High Dispute Volumes

### Observable Symptoms

- Dispute count exceeds normal volume (>10% of markets daily)
- Backend dispute handling queue backing up
- User reports of delays in dispute resolution
- Database shows `status: "disputed"` for many recent markets

### Diagnostic Procedures

**Step 1: Check Dispute Metrics**
```bash
# Query recent disputes
curl -s "http://localhost:3001/api/markets?status=disputed&limit=100" | jq '.total'

# Compare to historical baseline (usually <1% of markets)
# If >5%, investigate further
```

**Step 2: Analyze Dispute Patterns**
```bash
# Group disputes by market/oracle
curl -s "http://localhost:3001/api/disputes?limit=500" | jq '
  group_by(.market_id) | 
  map({
    market_id: .[0].market_id,
    count: length,
    disputants: map(.disputer) | unique | length
  }) | 
  sort_by(.count) | reverse | .[0:10]
'

# Check if concentrated on few markets or widespread
```

**Step 3: Review Oracle Submissions**
```bash
# Check for conflicting oracle data
curl -s "http://localhost:3001/api/oracle/submissions?sort=latest&limit=50" | jq '
  group_by(.market_id) | 
  map(select(length > 1)) |
  map({market_id: .[0].market_id, outcomes: map(.outcome) | unique})
'
```

### Resolution Steps

**For Oracle Conflicts:**

1. **Verify Facts:**
   - Check official event results from multiple sources
   - Obtain video/photographic evidence if available
   - Consult domain experts (sports analysts, judges)

2. **Manual Resolution:**
   ```bash
   # Resolve market to correct outcome with evidence
   stellar contract invoke \
       --id {MARKET_FACTORY_ADDRESS} \
       --source {ADMIN_SECRET_KEY} \
       --network mainnet \
       -- admin_resolve_dispute \
       --market-id {market_id} \
       --correct-outcome {fighter_a|fighter_b|draw}
   ```

3. **Communicate Resolution:**
   - Post explanation in dispute thread
   - Link to evidence/sources
   - Notify affected users

**For Frivolous Disputes:**

1. **Reject with evidence:**
   ```bash
   stellar contract invoke \
       --id {MARKET_FACTORY_ADDRESS} \
       --source {ADMIN_SECRET_KEY} \
       --network mainnet \
       -- admin_reject_dispute \
       --market-id {market_id} \
       --reason "Oracle submission verified against official results"
   ```

2. **Document pattern** - If same user files many frivolous disputes, flag for review

**For Systemic Oracle Issues:**

- See [Oracle Failures](#oracle-failures--unresolved-markets) section
- Consider adding additional trusted oracles
- Review oracle selection criteria

### Escalation Protocol

- **Level 1 (1-2% disputes):** Route to dispute review team
- **Level 2 (2-5% disputes):** Daily standups, investigate oracle reliability
- **Level 3 (>5% disputes):** Pause new market creation pending investigation

---

## RPC Node Outages

### Observable Symptoms

- All contract operations timeout or fail with connection errors
- Error logs show: `SOROBAN_RPC connection refused` or `timeout`
- Frontend shows "Unable to connect to blockchain" message
- Stellar CLI commands fail with network errors

### Diagnostic Procedures

**Step 1: Check RPC Connectivity**
```bash
# Test Soroban RPC endpoint
curl -s -X POST "$STELLAR_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "getNetwork", "params": []}' | jq '.result.network'

# Expected: returns network identifier (e.g., "Test SDF Network")
```

**Step 2: Verify Horizon API**
```bash
# Check Horizon connectivity
curl -s "$HORIZON_URL/health" | jq '.status'

# Expected: returns "healthy"
```

**Step 3: Check Fallback Nodes**
```bash
# If using custom RPC, test public fallback
STELLAR_RPC_URL=https://soroban-testnet.stellar.org curl -s -X POST "$STELLAR_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "getNetwork", "params": []}'
```

### Resolution Steps

**For Private RPC Node Outage:**

1. **Check Node Status:**
   ```bash
   # SSH to RPC node
   ssh user@rpc-node-host
   
   # Check service status
   systemctl status soroban-rpc
   
   # View recent logs
   journalctl -u soroban-rpc -n 50 --no-pager
   ```

2. **Restart Service:**
   ```bash
   systemctl restart soroban-rpc
   
   # Verify startup (wait 30-60 seconds for sync)
   sleep 60
   curl -s http://localhost:8000/health | jq '.ledgerCloseTime'
   ```

3. **If Restart Fails:**
   - Check disk space: `df -h`
   - Check memory: `free -h`
   - Check logs for specific errors
   - Consider snapshot restore or re-sync

**For Public RPC Outage (Stellar-hosted):**

1. **Switch to Fallback:**
   ```bash
   # Temporarily use different RPC provider
   export STELLAR_RPC_URL="https://soroban-mainnet.stellar.org"  # or alternative
   
   # Restart application servers
   systemctl restart frontend
   systemctl restart indexer
   ```

2. **Monitor Status:**
   - Check Stellar status page: https://status.stellar.org
   - Wait for official announcement of restoration
   - Monitor fallback node performance

3. **Update Configuration:**
   - If switching permanently, update deploy.sh and environment files
   - Notify team of new RPC endpoint
   - Test thoroughly before production traffic

**For Network Sync Lag:**

```bash
# Check if node is catching up to current ledger
curl -s http://localhost:8000/health | jq '{
  ledger_close_time: .ledgerCloseTime,
  current_time: (now * 1000)
}'

# If difference > 60 seconds, node is lagging
# Wait for sync to complete (can take 10-30 minutes for full catch-up)
```

### Escalation Protocol

- **Level 1 (0-5 min):** Check RPC health, verify connectivity
- **Level 2 (5-30 min):** Restart services, consider failover
- **Level 3 (>30 min):** Executive notification, activate disaster recovery plan

---

## Quick Reference: CLI Commands

### Force Cancel Market

Cancel a market and refund all bettors. Use when market cannot be resolved normally (e.g., event cancelled, oracle failure).

```bash
# Cancel market and trigger refunds
stellar contract invoke \
    --id {MARKET_FACTORY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network mainnet \
    -- admin_cancel_market \
    --market-id {market_id} \
    --reason "event_cancelled"  # or oracle_failure, technical_issue, etc.

# Verify cancellation
stellar contract invoke \
    --id {MARKET_FACTORY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network mainnet \
    -- query_market \
    --market-id {market_id} | jq '.status'

# Expected output: "cancelled"
```

### Emergency Pause

Pause all market operations (freeze all contracts).

```bash
# Pause market factory
stellar contract invoke \
    --id {MARKET_FACTORY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network mainnet \
    -- admin_pause

# Pause treasury
stellar contract invoke \
    --id {TREASURY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network mainnet \
    -- admin_pause

# Verify pause
stellar contract invoke \
    --id {MARKET_FACTORY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network mainnet \
    -- is_paused

# Expected output: true
```

### Treasury Drainage

Emergency withdrawal of all funds from treasury (for critical financial incidents).

```bash
# Get current treasury balance
stellar contract invoke \
    --id {TREASURY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network mainnet \
    -- get_treasury_state | jq '.balance_stroops'

# Drain treasury to admin account
stellar contract invoke \
    --id {TREASURY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network mainnet \
    -- admin_drain \
    --target-address {ADMIN_ADDRESS} \
    --amount {AMOUNT_STROOPS}

# Verify drain
stellar account info --source {ADMIN_ADDRESS} --network mainnet | jq '.balances'
```

### Market Force Resolution

Manually resolve a stuck market.

```bash
# Force resolve to specific outcome
stellar contract invoke \
    --id {MARKET_FACTORY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network mainnet \
    -- admin_force_resolve \
    --market-id {market_id} \
    --outcome fighter_a  # or fighter_b, draw, no_contest

# Verify resolution
stellar contract invoke \
    --id {MARKET_FACTORY_ADDRESS} \
    --source {ADMIN_SECRET_KEY} \
    --network mainnet \
    -- query_market \
    --market-id {market_id} | jq '.outcome'

# Expected output: "fighter_a"
```

---

## Environment Variables Reference

Key environment variables for production operations:

```bash
# Blockchain Configuration
STELLAR_RPC_URL=https://soroban-mainnet.stellar.org
HORIZON_URL=https://horizon.stellar.org
NETWORK=mainnet

# Contract Addresses (from deployments.json)
TREASURY_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
MARKET_FACTORY_ADDRESS=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Admin Keys (secure storage only)
ADMIN_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

## Further Documentation

- Refer to [README.md](../README.md) for general setup and architecture
- See [contributing.md](contributing.md) for development and deployment practices
- Check [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) for contract details
