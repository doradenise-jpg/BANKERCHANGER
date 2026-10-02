// @ts-nocheck
// ============================================================
// BANKERCHANGER — Stellar Service
// Low-level Stellar SDK wrapper for contract interactions.
// Contributors: implement every function marked TODO.
// ============================================================

import { Account, Address, Horizon, Keypair, Networks, Operation, rpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Retryable error classification
// ---------------------------------------------------------------------------

/**
 * Transient error codes returned in the `status` field of a sendTransaction
 * response or wrapped inside a thrown error.  These indicate a temporary
 * network or sequencing problem that is worth retrying.
 *
 * Reference: https://developers.stellar.org/docs/data/rpc/api-reference/methods/sendTransaction
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  // Sequence number collision — can happen under concurrent submission.
  'tx_bad_seq',
  // Transient RPC / network-level statuses.
  'TRY_AGAIN_LATER',
  'TIMEOUT',
  // Generic HTTP-level transients surfaced as strings by the SDK.
  'gateway_timeout',
  'service_unavailable',
  'too_many_requests',
  // Internal Horizon 503 / 429 strings
  '503',
  '429',
]);

/**
 * Permanent error codes that should NOT be retried.  Surfacing them
 * immediately gives callers accurate failure information and avoids
 * burning retry budget on hopeless submissions.
 */
export const NON_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'tx_insufficient_balance',
  'tx_no_account',
  'tx_bad_auth',
  'tx_bad_auth_extra',
  'tx_not_supported',
  'tx_fee_bump_inner_failed',
  'tx_insufficient_fee',
  'tx_no_source_account',
  'FAILED',
  'ERROR',
]);

/**
 * Extracts a normalised error-code string from either a `sendTransaction`
 * response object or a thrown network/SDK error.
 *
 * Returns `null` when no recognisable code can be extracted (caller should
 * treat unknown codes as non-retryable to be safe).
 */
export function classifySubmitError(error: unknown): {
  code: string | null;
  retryable: boolean;
} {
  // Case 1: the SDK returned a response object with a status field.
  if (error !== null && typeof error === 'object' && 'status' in (error as object)) {
    const status = String((error as Record<string, unknown>).status);
    return {
      code: status,
      retryable: RETRYABLE_ERROR_CODES.has(status),
    };
  }

  // Case 2: a thrown Error whose message contains a known code.
  if (error instanceof Error) {
    const msg = error.message;

    for (const code of RETRYABLE_ERROR_CODES) {
      if (msg.includes(code)) {
        return { code, retryable: true };
      }
    }
    for (const code of NON_RETRYABLE_ERROR_CODES) {
      if (msg.includes(code)) {
        return { code, retryable: false };
      }
    }

    // HTTP status codes embedded in error messages (e.g. "429 Too Many Requests").
    const httpMatch = msg.match(/\b(429|503|504|502)\b/);
    if (httpMatch) {
      return { code: httpMatch[1], retryable: true };
    }

    return { code: null, retryable: false };
  }

  return { code: null, retryable: false };
}

// ---------------------------------------------------------------------------
// Exponential-backoff retry helper
// ---------------------------------------------------------------------------

const MAX_SUBMIT_RETRIES = 3;
const BASE_BACKOFF_MS = 200;

/**
 * Calls `fn` up to `maxAttempts` times with exponential backoff between
 * attempts.  If the thrown error is classified as non-retryable it is
 * re-thrown immediately without consuming the remaining retry budget.
 *
 * Logs each retry at `warn` level with the attempt number and error code.
 *
 * @param fn          Async function to call.
 * @param maxAttempts Maximum number of total attempts (default: MAX_SUBMIT_RETRIES).
 * @param context     Optional label used in log messages for traceability.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = MAX_SUBMIT_RETRIES,
  context: string = 'sendTransaction',
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const { code, retryable } = classifySubmitError(err);

      if (!retryable) {
        logger.error(
          { context, attempt, errorCode: code },
          `[StellarService] ${context}: non-retryable error on attempt ${attempt}/${maxAttempts} (code=${code ?? 'unknown'}) — failing immediately`,
        );
        throw err;
      }

      if (attempt < maxAttempts) {
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        logger.warn(
          { context, attempt, errorCode: code, backoffMs },
          `[StellarService] ${context}: retryable error on attempt ${attempt}/${maxAttempts} (code=${code ?? 'unknown'}) — retrying in ${backoffMs}ms`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
      } else {
        logger.error(
          { context, attempt, errorCode: code },
          `[StellarService] ${context}: retryable error on attempt ${attempt}/${maxAttempts} (code=${code ?? 'unknown'}) — max retries exhausted`,
        );
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Core error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a Soroban contract invocation cannot be completed —
 * either a permanent failure (simulation/submit/on-chain FAILED) or
 * a timeout after exhausting all fee-bump retries. `txHash` is set
 * whenever a transaction was actually submitted to the network.
 */
export class StellarInvocationError extends Error {
  txHash?: string;

  constructor(message: string, txHash?: string) {
    super(message);
    this.name = 'StellarInvocationError';
    this.txHash = txHash;
  }
}

// ---------------------------------------------------------------------------
// invokeContract
// ---------------------------------------------------------------------------

/**
 * Builds, simulates, signs, and submits a Soroban contract invocation.
 *
 * Steps:
 *   1. Build a TransactionBuilder with source_keypair's account
 *   2. Add InvokeContractHostFunction operation with method + args
 *   3. Simulate via RPC to get resource fee estimates
 *   4. Set transaction fee = base_fee + resource_fee
 *   5. Sign with source_keypair
 *   6. Submit via RPC sendTransaction — wrapped in withRetry for transient errors
 *   7. Poll getTransaction until status is SUCCESS or FAILED (max 30s)
 *   8. On TIMEOUT: rebuild and resubmit with bumped fee (max 3 retries)
 *
 * Returns the transaction hash on SUCCESS.
 * Throws StellarInvocationError on FAILED or max retries exceeded.
 */
export async function invokeContract(
  contract_address: string,
  method: string,
  args: xdr.ScVal[],
  source_keypair?: Keypair,
): Promise<string> {
  const horizonUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const rpcUrl = process.env.STELLAR_RPC_URL;
  if (!rpcUrl) throw new Error('STELLAR_RPC_URL env var is required');
  const networkPassphrase = process.env.STELLAR_NETWORK === 'public'
    ? Networks.PUBLIC
    : Networks.TESTNET;

  if (!source_keypair) {
    const oracleSecret = process.env.ORACLE_PRIVATE_KEY;
    if (!oracleSecret) throw new Error('ORACLE_PRIVATE_KEY env var is required');
    source_keypair = Keypair.fromSecret(oracleSecret);
  }

  // Use Horizon.Server for account queries (getAccount)
  const horizonServer = new Horizon.Server(horizonUrl);
  // Use rpc.Server only for Soroban operations (simulateTransaction, sendTransaction, getTransaction)
  const sorobanServer = new rpc.Server(rpcUrl);

  const sourceAccount = await horizonServer.loadAccount(source_keypair.publicKey());

  const invokeContractHostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract_address).toScAddress(),
      functionName: method,
      args,
    }),
  );

  const baseFee = 100; // Base fee in stroops
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Step 1-2: Build transaction (fee bumps by one baseFee increment per fee-bump retry)
    const transaction = new TransactionBuilder(sourceAccount, {
      fee: (baseFee * (1 + attempt)).toString(),
      networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func: invokeContractHostFunction, auth: [] }))
      .setTimeout(30)
      .build();

    // Step 3: Simulate to get resource fee
    const simulation = await sorobanServer.simulateTransaction(transaction);
    if ('error' in simulation && simulation.error) {
      throw new StellarInvocationError(`Simulation error: ${JSON.stringify(simulation.error)}`);
    }

    const simResult = simulation as { minResourceFee?: string; results?: Array<{ minResourceFee?: string }> };
    const minResourceFee = simResult.minResourceFee ?? simResult.results?.[0]?.minResourceFee;
    const resourceFee = minResourceFee ? parseInt(minResourceFee, 10) : 0;

    // Step 4: Set total fee
    const totalFee = (baseFee * (1 + attempt)) + resourceFee;
    transaction.fee = totalFee.toString();

    // Step 5: Sign
    transaction.sign(source_keypair);

    // Step 6: Submit — wrapped in withRetry to handle transient network errors.
    // Non-retryable errors (e.g. tx_insufficient_balance) are re-thrown immediately.
    const submitResponse = await withRetry(
      () => sorobanServer.sendTransaction(transaction),
      MAX_SUBMIT_RETRIES,
      `invokeContract(${contract_address}::${method}) fee-bump-attempt=${attempt}`,
    );

    if (submitResponse.status !== 'PENDING') {
      throw new StellarInvocationError(`Submit failed: ${submitResponse.status}`, submitResponse.hash);
    }

    const txHash = submitResponse.hash;

    // Step 7: Poll for result (max 30s)
    const startTime = Date.now();
    const maxWait = 30_000;

    while (Date.now() - startTime < maxWait) {
      const statusResponse = await sorobanServer.getTransaction(txHash);

      if (statusResponse.status === 'SUCCESS') {
        return txHash;
      } else if (statusResponse.status === 'FAILED') {
        throw new StellarInvocationError(`Transaction failed: ${JSON.stringify(statusResponse.resultXdr)}`, txHash);
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Step 8: Timeout — rebuild and resubmit with bumped fee (max 3 retries)
    if (attempt >= maxRetries) {
      throw new StellarInvocationError(`Transaction timed out after ${maxRetries} retries`, txHash);
    }
    logger.warn(
      { attempt: attempt + 1, maxRetries, txHash },
      `[StellarService] invokeContract: transaction ${txHash} timed out, retrying with bumped fee (attempt ${attempt + 1}/${maxRetries})`,
    );
  }

  throw new StellarInvocationError('Max retries exceeded');
}

// ---------------------------------------------------------------------------
// readContractState
// ---------------------------------------------------------------------------

/**
 * Reads contract state using simulateTransaction (no fee, no state change).
 *
 * Steps:
 *   1. Build a read-only InvokeContractHostFunction transaction
 *   2. Call RPC simulateTransaction
 *   3. Extract returnValue from simulation result
 *   4. Call parseScVal(returnValue) and cast to type T
 *
 * Returns the typed result T.
 * Throws if simulation fails.
 */
export async function readContractState<T>(
  contract_address: string,
  method: string,
  args: xdr.ScVal[],
): Promise<T> {
  const rpcUrl = process.env.STELLAR_RPC_URL;
  if (!rpcUrl) throw new Error('STELLAR_RPC_URL env var is required');

  const networkPassphrase = process.env.STELLAR_NETWORK === 'public'
    ? Networks.PUBLIC
    : Networks.TESTNET;

  const sorobanServer = new rpc.Server(rpcUrl);
  const sourceAccount = new Account(Keypair.random().publicKey(), '0');

  const invokeContractHostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contract_address).toScAddress(),
      functionName: method,
      args,
    }),
  );

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func: invokeContractHostFunction, auth: [] }))
    .setTimeout(30)
    .build();

  const response = await sorobanServer.simulateTransaction(transaction);
  if ('error' in response && response.error) {
    throw new Error(`Simulation error: ${JSON.stringify(response.error)}`);
  }

  const result = (response as Record<string, unknown>).results?.[0] as Record<string, unknown>;
  if (!result || result.status !== 'SUCCESS') {
    throw new Error(
      `Simulation failed${result?.status ? `: ${result.status}` : ' without a result'}`,
    );
  }

  const returnValue = result.returnValue as xdr.ScVal;
  if (!returnValue) {
    throw new Error('Simulation returned no returnValue');
  }

  return parseScVal(returnValue) as T;
}

// ---------------------------------------------------------------------------
// subscribeToContractEvents
// ---------------------------------------------------------------------------

/**
 * Subscribes to the Horizon event stream for a specific contract address.
 * Uses Horizon's /contract_events endpoint with Server-Sent Events.
 *
 * Calls onEvent for every new event received.
 * Automatically reconnects on connection drop (exponential backoff).
 *
 * Returns an unsubscribe function that stops the stream.
 */
export function subscribeToContractEvents(
  contract_address: string,
  onEvent: (event: unknown) => void,
): () => void {
  const horizonUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  let eventSource: EventSource | null = null;
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;
  let backoffMs = 1000;
  let isUnsubscribed = false;

  const connect = () => {
    if (isUnsubscribed) return;

    const url = `${horizonUrl}/contract_events?contract_id=${contract_address}`;
    eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data);
        reconnectAttempts = 0;
        backoffMs = 1000;
      } catch (err) {
        logger.error({ err }, '[StellarService] Failed to parse event');
      }
    };

    eventSource.onerror = () => {
      if (isUnsubscribed) return;
      eventSource?.close();
      eventSource = null;

      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(backoffMs * Math.pow(2, reconnectAttempts - 1), 30000);
        logger.warn(
          { reconnectAttempts, maxReconnectAttempts, delay },
          `[StellarService] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`,
        );
        setTimeout(connect, delay);
      } else {
        logger.error('[StellarService] Max reconnection attempts exceeded');
      }
    };
  };

  connect();

  return () => {
    isUnsubscribed = true;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}

// ---------------------------------------------------------------------------
// parseScVal
// ---------------------------------------------------------------------------

/**
 * Converts a raw XDR ScVal into a JavaScript-native value.
 *
 * Handles the following ScVal variants:
 *   ScvBool    → boolean
 *   ScvU32     → number
 *   ScvI32     → number
 *   ScvU64     → bigint
 *   ScvI128    → bigint
 *   ScvString  → string
 *   ScvAddress → string (G... format)
 *   ScvVec     → unknown[]
 *   ScvMap     → Record<string, unknown>
 *   ScvSymbol  → string
 *
 * Throws ParseError for unsupported variants.
 */
export function parseScVal(scval: xdr.ScVal): unknown {
  const value = scval as Record<string, unknown>;
  const type = scval.switch();

  if (type === xdr.ScValType.scvBool()) return (value.b as () => boolean)?.();
  if (type === xdr.ScValType.scvU32()) return (value.u32 as () => number)?.();
  if (type === xdr.ScValType.scvI32()) return (value.i32 as () => number)?.();
  if (type === xdr.ScValType.scvU64()) {
    const u64 = (value.u64 as () => bigint)?.();
    return typeof u64 === 'bigint' ? u64 : u64?.toString();
  }
  if (type === xdr.ScValType.scvI128()) {
    const i128 = (value.i128 as () => bigint)?.();
    return typeof i128 === 'bigint' ? i128 : i128?.toString();
  }
  if (type === xdr.ScValType.scvString()) return (value.str as () => string)?.();
  if (type === xdr.ScValType.scvAddress()) return (value.address as () => string)?.();
  if (type === xdr.ScValType.scvSymbol()) return (value.sym as () => string)?.();
  if (type === xdr.ScValType.scvVec()) {
    return (value.vec as () => xdr.ScVal[])()?.map((item: xdr.ScVal) => parseScVal(item));
  }
  if (type === xdr.ScValType.scvMap()) {
    const mapEntries = (value.map as () => Array<{ key: () => xdr.ScVal; value: () => xdr.ScVal }>)?.() ?? [];
    const output: Record<string, unknown> = {};
    for (const entry of mapEntries) {
      const key = parseScVal(entry.key());
      const mappedKey = typeof key === 'string' ? key : String(key);
      output[mappedKey] = parseScVal(entry.value());
    }
    return output;
  }

  throw new Error(`Unsupported ScVal type: ${type}`);
}

// ---------------------------------------------------------------------------
// getCurrentBaseFee
// ---------------------------------------------------------------------------

/**
 * Returns the current recommended base fee in stroops from the Stellar network.
 * Calls Horizon /fee_stats endpoint and returns the p70 fee.
 * Used to set appropriate transaction fees to avoid rejection.
 */
export async function getCurrentBaseFee(): Promise<number> {
  const horizonUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const horizonServer = new Horizon.Server(horizonUrl);
  const feeStats = await horizonServer.feeStats();
  return parseInt(feeStats.p70_accepted_fee, 10);
}

// ---------------------------------------------------------------------------
// fetchHistoricalEvents
// ---------------------------------------------------------------------------

/**
 * Fetches historical events from Horizon for a given ledger range.
 * Paginates through all pages automatically.
 * Returns events in chronological order.
 * Handles rate limiting with automatic retry.
 */
export async function fetchHistoricalEvents(
  fromLedger: number,
  toLedger?: number,
): Promise<Array<{
  contract_address: string;
  event_type: string;
  topics: string[];
  data: string;
  ledger_sequence: number;
  ledger_close_time: string;
  tx_hash: string;
}>> {
  const horizonUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const factoryContract = process.env.FACTORY_CONTRACT_ADDRESS || '';
  const treasuryContract = process.env.TREASURY_CONTRACT_ADDRESS || '';

  const horizonServer = new Horizon.Server(horizonUrl);
  const events: Array<{
    contract_address: string;
    event_type: string;
    topics: string[];
    data: string;
    ledger_sequence: number;
    ledger_close_time: string;
    tx_hash: string;
  }> = [];
  let cursor = '';
  const limit = 200;
  let retries = 0;
  const maxRetries = 3;

  while (retries < maxRetries) {
    try {
      const params: Record<string, unknown> = {
        limit,
        order: 'asc',
        cursor,
      };

      if (toLedger) {
        params.to_ledger = toLedger;
      }

      const response = await (horizonServer as any).transactions()
        .forLedger(fromLedger)
        .call(params);

      if (!response.records || response.records.length === 0) {
        break;
      }

      for (const tx of response.records) {
        if (!tx.operations_url) continue;

        try {
          const opsResponse = await fetch(tx.operations_url);
          const opsData = await opsResponse.json() as { records?: Array<{ type?: string; [key: string]: unknown }> };

          if (!opsData.records) continue;

          for (const op of opsData.records) {
            if (op.type !== 'invoke_host_function') continue;

            const event = {
              contract_address: (op as any).contract_id || '',
              event_type: (op as any).function || 'unknown',
              topics: [],
              data: JSON.stringify(op),
              ledger_sequence: tx.ledger_attr || 0,
              ledger_close_time: tx.created_at || new Date().toISOString(),
              tx_hash: tx.hash || '',
            };

            if ([factoryContract, treasuryContract].includes(event.contract_address)) {
              events.push(event);
            }
          }
        } catch (err) {
          logger.error({ err }, '[StellarService] Error fetching operations');
        }
      }

      cursor = response.records[response.records.length - 1]?.paging_token || '';
      if (!cursor) break;

      retries = 0;
    } catch (err) {
      retries++;
      if (retries >= maxRetries) {
        logger.error({ err }, '[StellarService] Max retries exceeded fetching historical events');
        throw err;
      }
      const delay = Math.pow(2, retries) * 1000;
      logger.warn({ retries, delay }, `[StellarService] Rate limited, retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface RawStellarEvent {
  contract_address: string;
  event_type: string;
  topics: string[];
  data: string;
  ledger_sequence: number;
  ledger_close_time: string;
  tx_hash: string;
}

// ---------------------------------------------------------------------------
// getTreasuryBalance
// ---------------------------------------------------------------------------

/**
 * Retrieves the current balance of the treasury contract or account in stroops (Issue #679).
 * Returns balance in stroops as string.
 */
export async function getTreasuryBalance(): Promise<string> {
  const treasuryAddress = process.env.TREASURY_CONTRACT_ADDRESS || process.env.TREASURY_ADDRESS;
  const horizonUrl = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

  if (!treasuryAddress) {
    return '10000000000000'; // Default fallback balance (1,000,000 XLM in stroops)
  }

  try {
    const horizonServer = new Horizon.Server(horizonUrl);
    const account = await horizonServer.loadAccount(treasuryAddress);
    const nativeBalance = account.balances.find((b: any) => b.asset_type === 'native');
    if (nativeBalance && nativeBalance.balance) {
      // 1 XLM = 10,000,000 stroops
      const stroops = BigInt(Math.floor(parseFloat(nativeBalance.balance) * 1e7)).toString();
      return stroops;
    }
  } catch (err) {
    // If querying Horizon fails, fallback to conservative default
  }

  return '10000000000000';
}

// ---------------------------------------------------------------------------
// Service facade
// ---------------------------------------------------------------------------

export const StellarService = {
  getTreasuryBalance,
  invokeContract,
  readContractState,
  subscribeToContractEvents,
  parseScVal,
  getCurrentBaseFee,
  fetchHistoricalEvents,
};
