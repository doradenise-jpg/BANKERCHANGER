import { SorobanRpc, xdr, scValToNative } from '@stellar/stellar-sdk';
import { db } from '../db';
import { blockchainEvents } from '../db/schema';
import { processEvent } from '../indexer/processEvent';
import { logger } from '../utils/logger';

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const FACTORY_CONTRACT_ID = process.env.FACTORY_CONTRACT_ID || '';

const server = new SorobanRpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });

/**
 * Known contract addresses the indexer cares about: the factory plus every
 * market contract it has deployed. Refreshed lazily from the database.
 */
let knownContracts: Set<string> | null = null;

async function getKnownContracts(): Promise<Set<string>> {
  if (knownContracts) return knownContracts;

  const contracts = new Set<string>();
  if (FACTORY_CONTRACT_ID) contracts.add(FACTORY_CONTRACT_ID);

  try {
    const markets = await db.query.markets.findMany({
      columns: { contractAddress: true },
    });
    for (const market of markets) {
      if (market.contractAddress) contracts.add(market.contractAddress);
    }
  } catch (err) {
    logger.warn('Failed to load known market contracts', { error: err });
  }

  knownContracts = contracts;
  return contracts;
}

/**
 * Invalidate the cached set of known contracts (e.g. after a new market is
 * created) so the next ledger picks up the new address.
 */
export function invalidateKnownContracts(): void {
  knownContracts = null;
}

/**
 * Process a single ledger: fetch all contract events, persist the raw event,
 * then dispatch known factory/market events to the handler in ledger order.
 */
export async function processLedger(ledger: number): Promise<void> {
  const contracts = await getKnownContracts();

  let events: SorobanRpc.Api.GetEventsResponse;
  try {
    events = await server.getEvents({
      startLedger: ledger,
      filters: [{ type: 'contract' }],
      limit: 200,
    });
  } catch (err) {
    logger.error('Failed to fetch contract events for ledger', { ledger, error: err });
    throw err;
  }

  // Only events belonging to this ledger, in ledger order.
  const ledgerEvents = events.events
    .filter((event) => event.ledger === ledger)
    .sort((a, b) => {
      if (a.ledger !== b.ledger) return a.ledger - b.ledger;
      return a.ledgerClosedAt.localeCompare(b.ledgerClosedAt);
    });

  for (const event of ledgerEvents) {
    const contractId = event.contractId;

    // Persist the raw event regardless of whether we handle it.
    try {
      await db.insert(blockchainEvents).values({
        ledger,
        contractId: contractId ?? null,
        eventType: event.type,
        txHash: event.txHash,
        topic: event.topic.map((t) => scValToNative(t)),
        value: event.value ? scValToNative(event.value) : null,
        rawEvent: event as unknown as Record<string, unknown>,
        processed: false,
      });
    } catch (err) {
      logger.error('Failed to persist raw blockchain event', {
        ledger,
        txHash: event.txHash,
        error: err,
      });
      // Continue: persistence failure should not abort the whole ledger.
    }

    // Skip unknown contract addresses gracefully.
    if (!contractId || !contracts.has(contractId)) {
      logger.debug('Skipping event from unknown contract', { ledger, contractId });
      continue;
    }

    try {
      await processEvent(event);
    } catch (err) {
      logger.error('Failed to process contract event', {
        ledger,
        contractId,
        txHash: event.txHash,
        error: err,
      });
    }
  }
}
