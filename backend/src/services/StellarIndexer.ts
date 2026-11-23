import { SorobanRpc, xdr, scValToNative } from '@stellar/stellar-sdk';
import { Pool } from 'pg';
import { logger } from '../utils/logger';

export interface StellarIndexerConfig {
  rpcUrl: string;
  networkPassphrase: string;
  factoryContractId: string;
  marketContractIds: string[];
  pollIntervalMs?: number;
  startLedger?: number;
}

export interface ContractEventRecord {
  ledger: number;
  txHash: string;
  contractId: string;
  topic: string[];
  value: unknown;
  raw: unknown;
}

export class StellarIndexer {
  private readonly server: SorobanRpc.Server;
  private readonly db: Pool;
  private readonly config: StellarIndexerConfig;
  private readonly knownContracts: Set<string>;
  private running = false;
  private lastProcessedLedger: number;

  constructor(db: Pool, config: StellarIndexerConfig) {
    this.db = db;
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith('http://'),
    });
    this.knownContracts = new Set<string>([
      config.factoryContractId,
      ...config.marketContractIds,
    ]);
    this.lastProcessedLedger = config.startLedger ?? 0;
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.warn('StellarIndexer already running');
      return;
    }
    this.running = true;
    logger.info('StellarIndexer starting', {
      lastProcessedLedger: this.lastProcessedLedger,
    });

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        logger.error('StellarIndexer tick failed', { error: err });
      }
      await this.sleep(this.config.pollIntervalMs ?? 5000);
    }
  }

  stop(): void {
    this.running = false;
  }

  private async tick(): Promise<void> {
    const latest = await this.server.getLatestLedger();
    const target = latest.sequence;

    for (let ledger = this.lastProcessedLedger + 1; ledger <= target; ledger++) {
      await this.processLedger(ledger);
      this.lastProcessedLedger = ledger;
    }
  }

  /**
   * Process all contract events for a single ledger.
   *
   * - Queries Stellar RPC for every contract event in the ledger.
   * - Filters to known factory and market contract addresses.
   * - Persists the raw event to blockchain_events before invoking the handler.
   * - Calls processEvent() for each known event in ledger order.
   */
  async processLedger(ledger: number): Promise<void> {
    const events = await this.fetchContractEvents(ledger);

    // RPC returns events in ledger order; sort defensively to guarantee ordering.
    events.sort((a, b) => {
      if (a.ledger !== b.ledger) return a.ledger - b.ledger;
      return a.eventIndex - b.eventIndex;
    });

    for (const event of events) {
      const contractId = event.contractId;

      // Persist raw event regardless of whether the address is known or the
      // handler succeeds, so no on-chain data is ever lost.
      await this.persistRawEvent(event);

      if (!contractId || !this.knownContracts.has(contractId)) {
        logger.debug('Skipping event from unknown contract', {
          ledger,
          contractId,
        });
        continue;
      }

      try {
        await this.processEvent(event);
      } catch (err) {
        logger.error('processEvent failed', {
          ledger,
          contractId,
          txHash: event.txHash,
          error: err,
        });
      }
    }
  }

  private async fetchContractEvents(ledger: number): Promise<RawContractEvent[]> {
    const response = await this.server.getEvents({
      startLedger: ledger,
      endLedger: ledger,
      filters: [
        {
          type: 'contract',
        },
      ],
      limit: 200,
    });

    return response.events.map((event, index) => ({
      ledger: event.ledger,
      eventIndex: index,
      txHash: event.txHash,
      contractId: event.contractId?.toString() ?? '',
      topic: event.topic.map((t) => this.decodeScVal(t)),
      value: this.decodeScVal(event.value),
      raw: event,
    }));
  }

  private decodeScVal(value: xdr.ScVal): unknown {
    try {
      return scValToNative(value);
    } catch {
      return value.toXDR('base64');
    }
  }

  private async persistRawEvent(event: RawContractEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO blockchain_events
         (ledger, tx_hash, contract_id, topic, value, raw_event, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (ledger, tx_hash, contract_id, event_index) DO NOTHING`,
      [
        event.ledger,
        event.txHash,
        event.contractId,
        JSON.stringify(event.topic),
        JSON.stringify(event.value),
        JSON.stringify(event.raw),
      ],
    );
  }

  private async processEvent(event: RawContractEvent): Promise<void> {
    // Dispatch to the appropriate handler based on contract and topic.
    // Handlers are wired up by the indexer entrypoint; this base implementation
    // logs the event so subclasses/consumers can override.
    logger.info('Processing contract event', {
      ledger: event.ledger,
      contractId: event.contractId,
      txHash: event.txHash,
      topic: event.topic,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

interface RawContractEvent {
  ledger: number;
  eventIndex: number;
  txHash: string;
  contractId: string;
  topic: unknown[];
  value: unknown;
  raw: unknown;
}
