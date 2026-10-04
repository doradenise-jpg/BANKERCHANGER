// ============================================================
// BANKERCHANGER — Wallet Service
// Manages Freighter wallet connection and Stellar transactions.
// ============================================================

import {
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Address,
  xdr,
} from '@stellar/stellar-sdk';
import type { BetSide, CreateProposalParams, VoteType } from '../types';
import { xlmToStroops } from '../utils/xlmToStroops';

const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet';
const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  (NETWORK === 'mainnet'
    ? 'https://soroban-rpc.stellar.org'
    : 'https://soroban-testnet.stellar.org');
const NETWORK_PASSPHRASE =
  NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

const WALLET_STORAGE_KEY = 'bankerchanger_wallet_address';

/**
 * Storage Decision: sessionStorage vs localStorage
 * 
 * TRADE-OFF: Using sessionStorage instead of localStorage for wallet address.
 * 
 * sessionStorage benefits:
 *  - Auto-clears when tab/browser closes (security on shared/public devices)
 *  - Wallet connection cannot persist after logout or browser restart
 *  - Prevents token theft if device is compromised between sessions
 * 
 * Downside:
 *  - Users must reconnect wallet if they refresh the page or open a new tab
 * 
 * This choice prioritizes security on shared devices over convenience.
 * For public/shared computers, indefinite persistence is a significant risk.
 */

// ─── Custom Errors ───────────────────────────────────────────────────────────

export class WalletNotInstalledError extends Error {
  constructor(message: string = 'No wallet extension found. Install Freighter at https://freighter.app') {
    super(message);
    this.name = 'WalletNotInstalledError';
  }
}

export class WalletConnectionError extends Error {
  constructor(message: string = 'User rejected wallet connection') {
    super(message);
    this.name = 'WalletConnectionError';
  }
}

export class WalletSignError extends Error {
  constructor(message: string = 'User rejected transaction signing') {
    super(message);
    this.name = 'WalletSignError';
  }
}

export const WALLET_TRANSACTION_CANCELLED_MESSAGE =
  'Transaction cancelled — you declined the request in Freighter';

export class WalletTransactionCancelledError extends Error {
  constructor() {
    super(WALLET_TRANSACTION_CANCELLED_MESSAGE);
    this.name = 'WalletTransactionCancelledError';
  }
}

function createWalletSignError(error: unknown): Error {
  if (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    error.name === 'UserDeclinedAccess'
  ) {
    return new WalletTransactionCancelledError();
  }

  return new WalletSignError(
    error instanceof Error ? error.message : 'User rejected transaction signing',
  );
}

export class TxSubmissionError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'TxSubmissionError';
  }
}

// ─── Transaction helper with state callbacks ───────────────────────────────

export type TxStageCallback = (stage: 'signing' | 'broadcasting' | 'confirming') => void;

/**
 * Like buildAndSubmit but calls onStage at each phase so the UI can show granular status.
 * Phases: signing → broadcasting → confirming → returns hash
 */
async function buildAndSubmitWithStages(
  contractAddress: string,
  method: string,
  args: xdr.ScVal[],
  onStage: TxStageCallback,
): Promise<string> {
  const address = getConnectedAddress();
  if (!address) throw new Error('WalletNotConnected');

  const server = new SorobanRpc.Server(SOROBAN_RPC_URL);
  const account = await server.getAccount(address);
  const contract = new Contract(contractAddress);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  const txXdr = preparedTx.toXDR();

  const freighter = (window as any).freighter;
  if (!freighter) throw new Error('WalletNotInstalledError');

  // Phase 1: Signing
  onStage('signing');
  let signedTxXdr: string;
  try {
    const result = await freighter.signTransaction(txXdr, {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    signedTxXdr = result.signedTxXdr;
  } catch (error) {
    throw createWalletSignError(error);
  }

  // Phase 2: Broadcasting
  onStage('broadcasting');
  const submitRes = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE),
  );

  if (submitRes.status === 'ERROR') {
    throw new TxSubmissionError(
      `Network rejected transaction: ${submitRes.errorResult?.toString() || 'Unknown error'}`,
      submitRes.errorResult,
    );
  }

  // Phase 3: Confirming
  onStage('confirming');
  let getRes = await server.getTransaction(submitRes.hash);
  for (let i = 0; i < 20 && getRes.status === 'NOT_FOUND'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    getRes = await server.getTransaction(submitRes.hash);
  }

  if (getRes.status !== 'SUCCESS') {
    throw new TxSubmissionError(
      `Transaction failed with status: ${getRes.status}`,
      getRes,
    );
  }

  return submitRes.hash;
}

// ─── Transaction helper ───────────────────────────────────────────────────────

async function buildAndSubmit(
  contractAddress: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  return buildAndSubmitWithStages(contractAddress, method, args, () => {
    // No-op for backwards compatibility
  });
}

// ─── Wallet connection ────────────────────────────────────────────────────────

/** Returns which wallet extensions are installed in the current browser. */
export function detectWallets(): { freighter: boolean; albedo: boolean } {
  if (typeof window === 'undefined') return { freighter: false, albedo: false };
  return {
    freighter: !!(window as any).freighter,
    albedo: !!(window as any).albedo,
  };
}

export type WalletType = 'freighter' | 'albedo';

/**
 * Connect to a specific wallet extension by name.
 * Used by the wallet selection modal so each button connects to the
 * wallet the user explicitly chose (#360).
 */
export async function connectWalletByType(type: WalletType): Promise<string> {
  if (typeof window === 'undefined') throw new Error('Browser only');

  if (type === 'freighter') {
    const freighter = (window as any).freighter;
    if (!freighter) throw new WalletNotInstalledError('Freighter is not installed. Get it at https://freighter.app');
    try {
      await freighter.requestAccess();
      const { publicKey } = await freighter.getPublicKey();
      sessionStorage.setItem(WALLET_STORAGE_KEY, publicKey);
      return publicKey;
    } catch (err) {
      throw new WalletConnectionError(err instanceof Error ? err.message : 'User rejected wallet connection');
    }
  }

  if (type === 'albedo') {
    const albedo = (window as any).albedo;
    if (!albedo) throw new WalletNotInstalledError('Albedo is not installed. Get it at https://albedo.link');
    try {
      const { pubkey } = await albedo.publicKey({ token: 'boxmeout' });
      sessionStorage.setItem(WALLET_STORAGE_KEY, pubkey);
      return pubkey;
    } catch (err) {
      throw new WalletConnectionError(err instanceof Error ? err.message : 'User rejected wallet connection');
    }
  }

  throw new WalletNotInstalledError();
}

export async function connectWallet(): Promise<string> {
  if (typeof window === 'undefined') throw new Error('Browser only');
  
  const freighter = (window as any).freighter;
  const albedo = (window as any).albedo;
  
  // Try Freighter first if available
  if (freighter) {
    try {
      await freighter.requestAccess();
      const { publicKey } = await freighter.getPublicKey();
      sessionStorage.setItem(WALLET_STORAGE_KEY, publicKey);
      return publicKey;
    } catch (err) {
      throw new WalletConnectionError(
        err instanceof Error ? err.message : 'User rejected wallet connection',
      );
    }
  }
  
  // Try Albedo if Freighter is not available or connection failed
  if (albedo) {
    try {
      const { pubkey } = await albedo.publicKey({ token: 'bankerchanger' });
      sessionStorage.setItem(WALLET_STORAGE_KEY, pubkey);
      return pubkey;
    } catch (err) {
      throw new WalletConnectionError(
        err instanceof Error ? err.message : 'User rejected wallet connection',
      );
    }
  }
  
  // Neither wallet is installed - throw with helpful message
  throw new WalletNotInstalledError(
    'No wallet extension found. Install Freighter at https://freighter.app or Albedo at https://albedo.link',
  );
}

export function disconnectWallet(): void {
  sessionStorage.removeItem(WALLET_STORAGE_KEY);
}

export function getConnectedAddress(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(WALLET_STORAGE_KEY);
}

// ─── Contract invocations ─────────────────────────────────────────────────────

export async function submitBet(
  market_contract_address: string,
  side: BetSide,
  amount_xlm: number,
): Promise<string> {
  return buildAndSubmit(market_contract_address, 'place_bet', [
    nativeToScVal(side, { type: 'symbol' }),
    nativeToScVal(xlmToStroops(amount_xlm), { type: 'i128' }),
  ]);
}

export async function submitBetWithStages(
  market_contract_address: string,
  side: BetSide,
  amount_xlm: number,
  onStage: TxStageCallback,
): Promise<string> {
  return buildAndSubmitWithStages(market_contract_address, 'place_bet', [
    nativeToScVal(side, { type: 'symbol' }),
    nativeToScVal(xlmToStroops(amount_xlm), { type: 'i128' }),
  ], onStage);
}

export async function submitClaim(market_contract_address: string): Promise<string> {
  const bettor = getConnectedAddress();
  if (!bettor) throw new Error('WalletNotConnected');
  const token = process.env.NEXT_PUBLIC_XLM_TOKEN_ADDRESS;
  if (!token) throw new Error('NEXT_PUBLIC_XLM_TOKEN_ADDRESS not set');
  return buildAndSubmit(market_contract_address, 'claim_winnings', [
    new Address(bettor).toScVal(),
    new Address(token).toScVal(),
  ]);
}

/**
 * Like submitClaim but calls onStage at each phase so the UI can show granular status.
 */
export async function submitClaimWithStages(
  market_contract_address: string,
  onStage: TxStageCallback,
): Promise<string> {
  const address = getConnectedAddress();
  if (!address) throw new Error('WalletNotConnected');
  const token = process.env.NEXT_PUBLIC_XLM_TOKEN_ADDRESS;
  if (!token) throw new Error('NEXT_PUBLIC_XLM_TOKEN_ADDRESS not set');

  const server = new SorobanRpc.Server(SOROBAN_RPC_URL);
  const account = await server.getAccount(address);
  const contract = new Contract(market_contract_address);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'claim_winnings',
        new Address(address).toScVal(),
        new Address(token).toScVal(),
      ),
    )
    .setTimeout(30)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  const txXdr = preparedTx.toXDR();

  const freighter = (window as any).freighter;
  if (!freighter) throw new WalletNotInstalledError();

  onStage('signing');
  let signedTxXdr: string;
  try {
    const result = await freighter.signTransaction(txXdr, { networkPassphrase: NETWORK_PASSPHRASE });
    signedTxXdr = result.signedTxXdr;
  } catch (error) {
    throw createWalletSignError(error);
  }

  onStage('broadcasting');
  const submitRes = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE),
  );

  if (submitRes.status === 'ERROR') {
    throw new TxSubmissionError(
      `Network rejected transaction: ${submitRes.errorResult?.toString() || 'Unknown error'}`,
      submitRes.errorResult,
    );
  }

  onStage('confirming');
  let getRes = await server.getTransaction(submitRes.hash);
  for (let i = 0; i < 20 && getRes.status === 'NOT_FOUND'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    getRes = await server.getTransaction(submitRes.hash);
  }

  if (getRes.status !== 'SUCCESS') {
    throw new TxSubmissionError(`Transaction failed with status: ${getRes.status}`, getRes);
  }

  return submitRes.hash;
}

export async function submitRefund(market_contract_address: string): Promise<string> {
  const bettor = getConnectedAddress();
  if (!bettor) throw new Error('WalletNotConnected');
  const token = process.env.NEXT_PUBLIC_XLM_TOKEN_ADDRESS;
  if (!token) throw new Error('NEXT_PUBLIC_XLM_TOKEN_ADDRESS not set');
  return buildAndSubmit(market_contract_address, 'claim_refund', [
    new Address(bettor).toScVal(),
    new Address(token).toScVal(),
  ]);
}

export interface CreateMarketParams {
  matchId: string;
  fighterA: string;
  fighterB: string;
  weightClass: string;
  venue: string;
  titleFight: boolean;
  scheduledAt: string;
  minBetXlm: number;
  maxBetXlm: number;
  feeBps: number;
  lockBeforeMinutes: number;
}

export async function createMarket(params: CreateMarketParams): Promise<string> {
  const factoryAddress = process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS;
  if (!factoryAddress) throw new Error('NEXT_PUBLIC_MARKET_FACTORY_ADDRESS not set');
  return buildAndSubmit(factoryAddress, 'create_market', [
    nativeToScVal(params.matchId, { type: 'string' }),
    nativeToScVal(params.fighterA, { type: 'string' }),
    nativeToScVal(params.fighterB, { type: 'string' }),
    nativeToScVal(params.weightClass, { type: 'string' }),
    nativeToScVal(params.venue, { type: 'string' }),
    nativeToScVal(params.titleFight, { type: 'bool' }),
    nativeToScVal(BigInt(new Date(params.scheduledAt).getTime()), { type: 'u64' }),
    nativeToScVal(xlmToStroops(params.minBetXlm), { type: 'i128' }),
    nativeToScVal(xlmToStroops(params.maxBetXlm), { type: 'i128' }),
    nativeToScVal(params.feeBps, { type: 'u32' }),
    nativeToScVal(params.lockBeforeMinutes, { type: 'u32' }),
  ]);
}

export async function createProposal(params: CreateProposalParams): Promise<string> {
  const govAddress = process.env.NEXT_PUBLIC_GOVERNANCE_CONTRACT_ADDRESS;
  if (!govAddress) throw new Error('NEXT_PUBLIC_GOVERNANCE_CONTRACT_ADDRESS not set');
  
  // The exact arguments depend on the contract, we mock the basic structure
  // 'create_proposal' might take: type_id (u32), value (scval), description (string)
  // We represent the type as an integer for the contract here
  let typeInt = 0;
  let scValue: xdr.ScVal;
  
  switch(params.type) {
    case 'fee_rate':
      typeInt = 1;
      scValue = nativeToScVal(params.value, { type: 'u32' });
      break;
    case 'add_token':
      typeInt = 2;
      scValue = nativeToScVal(params.value, { type: 'address' });
      break;
    case 'remove_token':
      typeInt = 3;
      scValue = nativeToScVal(params.value, { type: 'address' });
      break;
    case 'max_discount_rate':
      typeInt = 4;
      scValue = nativeToScVal(params.value, { type: 'u32' });
      break;
    default:
      throw new Error('Invalid proposal type');
  }

  return buildAndSubmit(govAddress, 'create_proposal', [
    nativeToScVal(typeInt, { type: 'u32' }),
    scValue,
    nativeToScVal(params.description, { type: 'string' })
  ]);
}

export async function voteProposal(proposalId: string, vote: VoteType): Promise<string> {
  const govAddress = process.env.NEXT_PUBLIC_GOVERNANCE_CONTRACT_ADDRESS;
  if (!govAddress) throw new Error('NEXT_PUBLIC_GOVERNANCE_CONTRACT_ADDRESS not set');
  
  // Mapping 'for'=1, 'against'=2, 'abstain'=3
  const voteInt = vote === 'for' ? 1 : vote === 'against' ? 2 : 3;

  return buildAndSubmit(govAddress, 'vote', [
    nativeToScVal(proposalId, { type: 'string' }),
    nativeToScVal(voteInt, { type: 'u32' })
  ]);
}

export async function executeProposal(proposalId: string): Promise<string> {
  const govAddress = process.env.NEXT_PUBLIC_GOVERNANCE_CONTRACT_ADDRESS;
  if (!govAddress) throw new Error('NEXT_PUBLIC_GOVERNANCE_CONTRACT_ADDRESS not set');

  return buildAndSubmit(govAddress, 'execute_proposal', [
    nativeToScVal(proposalId, { type: 'string' })
  ]);
}

export async function markPaid(invoiceId: string): Promise<string> {
  const contractAddress = process.env.NEXT_PUBLIC_INVOICE_CONTRACT_ADDRESS;
  if (!contractAddress) throw new Error('NEXT_PUBLIC_INVOICE_CONTRACT_ADDRESS not set');

  return buildAndSubmit(contractAddress, 'mark_paid', [
    nativeToScVal(invoiceId, { type: 'string' })
  ]);
}

// ─── Balance ──────────────────────────────────────────────────────────────────

export async function getWalletBalance(): Promise<number> {
  const address = getConnectedAddress();
  if (!address) return 0;
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
    if (!res.ok) return 0;
    const data = await res.json();
    const native = (data.balances as any[]).find((b: any) => b.asset_type === 'native');
    return native ? parseFloat(native.balance) : 0;
  } catch {
    return 0;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export { xlmToStroops, stroopsToXlm } from '../utils/xlmToStroops';

export function stellarExplorerUrl(
  type: 'tx' | 'account' | 'contract',
  id: string,
): string {
  const network = NETWORK === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/${type}/${id}`;
}
