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
    const topicName = this.getTopicName(event);

    switch (topicName) {
      case 'MarketCreated':
        await this.handleMarketCreated(event);
        break;
      default:
        logger.info('Processing contract event', {
          ledger: event.ledger,
          contractId: event.contractId,
          txHash: event.txHash,
          topic: event.topic,
        });
    }
  }

  private getTopicName(event: RawContractEvent): string | undefined {
    const first = event.topic[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && 'symbol' in first) {
      return String((first as { symbol: unknown }).symbol);
    }
    return undefined;
  }

  /**
   * Handle a MarketCreated event emitted by the factory contract.
   *
   * Inserts a new market row with status 'open'. Uses ON CONFLICT DO NOTHING
   * keyed on market_id so duplicate events are idempotent.
   */
  async handleMarketCreated(event: RawContractEvent): Promise<void> {
    const data = this.extractEventData(event);

    const marketId = this.requireField<string>(data, 'market_id');
    const contractAddress = this.requireField<string>(data, 'contract_address');
    const matchId = this.requireField<string>(data, 'match_id');
    const fighterA = this.requireField<string>(data, 'fighter_a');
    const fighterB = this.requireField<string>(data, 'fighter_b');
    const weightClass = this.requireField<string>(data, 'weight_class');
    const scheduledAt = this.requireField<string | number>(data, 'scheduled_at');
    const feeBps = this.requireField<number>(data, 'fee_bps');
    const venue = this.requireField<string>(data, 'venue');
    const titleFight = this.requireField<boolean>(data, 'title_fight');

    const createdAt = this.toTimestamp(scheduledAt);

    await this.db.query(
      `INSERT INTO markets
         (market_id, contract_address, match_id, fighter_a, fighter_b,
          weight_class, scheduled_at, fee_bps, venue, title_fight,
          status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11)
       ON CONFLICT (market_id) DO NOTHING`,
      [
        marketId,
        contractAddress,
        matchId,
        fighterA,
        fighterB,
        weightClass,
        createdAt,
        feeBps,
        venue,
        titleFight,
        createdAt,
      ],
    );

    logger.info('MarketCreated handled', {
      ledger: event.ledger,
      marketId,
      contractAddress,
    });
  }

  private extractEventData(event: RawContractEvent): Record<string, unknown> {
    const value = event.value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private requireField<T>(data: Record<string, unknown>, field: string): T {
    const value = data[field];
    if (value === undefined || value === null) {
      throw new Error(`MarketCreated event missing required field: ${field}`);
    }
    return value as T;
  }

  private toTimestamp(value: string | number): Date {
    if (typeof value === 'number') {
      // Soroban timestamps are unix seconds; convert to milliseconds.
      return new Date(value * 1000);
    }
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
      return new Date(numeric * 1000);
    }
    return new Date(value);
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
