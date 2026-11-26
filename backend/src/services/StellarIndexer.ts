import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { SorobanRpc, xdr, scValToNative } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

// ── Event interfaces ──────────────────────────────────────────────────────────

interface BetPlacedEvent {
  bettor_address: string;
  market_id: string;
  side: string;
  amount_stroops: string;
  placed_at: string;
  tx_hash: string;
}

interface MarketResolvedEvent {
  market_id: string;
  outcome: string;
  oracle_address: string;
  oracle_role: string;
  resolved_at: string;
  tx_hash: string;
}

interface MarketLockedEvent {
  market_id: string;
  tx_hash: string;
}

interface MarketCancelledEvent {
  market_id: string;
  reason: string;
  tx_hash: string;
}

interface WinningsClaimedEvent {
  bettor_address: string;
  market_id: number;
  amount_won: bigint;
  fee_deducted: bigint;
  claimed_at: number;
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

// ── StellarIndexer ────────────────────────────────────────────────────────────

export class StellarIndexer {
  private readonly server: SorobanRpc.Server;
  private readonly knownContracts: Set<string>;
  private running = false;
  private lastProcessedLedger: number;

  constructor(
    private readonly db: Pool,
    private readonly config: StellarIndexerConfig,
  ) {
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith('http://'),
    });
    this.knownContracts = new Set<string>([
      config.factoryContractId,
      ...config.marketContractIds,
    ]);
    this.lastProcessedLedger = config.startLedger ?? 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

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
   */
  async processLedger(ledger: number): Promise<void> {
    const events = await this.fetchContractEvents(ledger);

    events.sort((a, b) => {
      if (a.ledger !== b.ledger) return a.ledger - b.ledger;
      return a.eventIndex - b.eventIndex;
    });

    for (const event of events) {
      const contractId = event.contractId;

      await this.persistRawEvent(event);

      if (!contractId || !this.knownContracts.has(contractId)) {
        logger.debug('Skipping event from unknown contract', { ledger, contractId });
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
      filters: [{ type: 'contract' }],
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
    const topicName = this.getTopicName(event);

    switch (topicName) {
      case 'MarketCreated':
        await this.handleMarketCreated(event);
        break;
      case 'WinningsClaimed': {
        const data = this.extractEventData(event);
        await this.handleWinningsClaimed({
          bettor_address: String(data.bettor_address),
          market_id: Number(data.market_id),
          amount_won: BigInt(String(data.amount_won)),
          fee_deducted: BigInt(String(data.fee_deducted)),
          claimed_at: Number(data.claimed_at),
        });
        break;
      }
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

  // ── Event handlers ─────────────────────────────────────────────────────────

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
        marketId, contractAddress, matchId, fighterA, fighterB,
        weightClass, createdAt, feeBps, venue, titleFight, createdAt,
      ],
    );

    logger.info('MarketCreated handled', { ledger: event.ledger, marketId, contractAddress });
  }

  async handleBetPlaced(event: BetPlacedEvent): Promise<void> {
    const { bettor_address, market_id, side, amount_stroops, placed_at, tx_hash } = event;

    const amountStroops = BigInt(amount_stroops);
    const amountXlm = Number(amountStroops) / 10_000_000;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO bets (bettor_address, market_id, side, amount_stroops, amount_xlm, placed_at, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [bettor_address, market_id, side, amount_stroops, amountXlm, placed_at, tx_hash],
      );

      if (insertResult.rowCount === 0) {
        await client.query('ROLLBACK');
        logger.info(`Duplicate BetPlaced tx_hash ${tx_hash}, skipping`);
        return;
      }

      const poolColumn = side === 'yes' ? 'yes_pool' : 'no_pool';
      await client.query(
        `UPDATE markets
         SET ${poolColumn} = ${poolColumn} + $1,
             total_pool = total_pool + $1
         WHERE market_id = $2`,
        [amountStroops.toString(), market_id],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Failed to handle BetPlaced event ${tx_hash}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  async handleMarketLocked(event: MarketLockedEvent): Promise<void> {
    const { market_id, tx_hash } = event;

    try {
      const result = await this.db.query(
        `UPDATE markets SET status = 'locked', updated_at = NOW() WHERE market_id = $1`,
        [market_id],
      );

      if (result.rowCount === 0) {
        logger.warn(`MarketLocked ${tx_hash}: market ${market_id} not found, skipping`);
        return;
      }

      logger.info(`MarketLocked ${market_id} status set to 'locked'`);
    } catch (err) {
      logger.error(`Failed to handle MarketLocked event ${tx_hash}`, err);
      throw err;
    }
  }

  async handleMarketResolved(event: MarketResolvedEvent): Promise<void> {
    const { market_id, outcome, oracle_address, oracle_role, resolved_at, tx_hash } = event;

    const normalizedOutcome = outcome.toUpperCase();
    if (!['A', 'B', 'DRAW'].includes(normalizedOutcome)) {
      logger.warn(`Invalid outcome '${outcome}' for MarketResolved ${tx_hash}, skipping`);
      return;
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE markets
         SET status = 'resolved', outcome = $1, resolved_at = $2, oracle_used = $3
         WHERE market_id = $4`,
        [normalizedOutcome, resolved_at, oracle_address, market_id],
      );

      const bettorsResult = await client.query(
        `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`,
        [market_id],
      );

      for (const row of bettorsResult.rows) {
        await client.query(
          `INSERT INTO push_notifications (recipient_address, market_id, type, payload, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            row.bettor_address, market_id, 'market_resolved',
            JSON.stringify({ market_id, outcome: normalizedOutcome, oracle_role }),
            resolved_at,
          ],
        );
      }

      await client.query('COMMIT');
      logger.info(
        `MarketResolved ${market_id} outcome=${normalizedOutcome} oracle=${oracle_address} (${oracle_role}), notified ${bettorsResult.rowCount} bettors`,
      );
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Failed to handle MarketResolved event ${tx_hash}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  async handleMarketCancelled(event: MarketCancelledEvent): Promise<void> {
    const { market_id, reason, tx_hash } = event;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const updateResult = await client.query(
        `UPDATE markets
         SET status = 'cancelled', cancel_reason = $1, updated_at = NOW()
         WHERE market_id = $2`,
        [reason, market_id],
      );

      if (updateResult.rowCount === 0) {
        await client.query('ROLLBACK');
        logger.warn(`MarketCancelled ${tx_hash}: market ${market_id} not found, skipping`);
        return;
      }

      const bettorsResult = await client.query(
        `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`,
        [market_id],
      );

      for (const row of bettorsResult.rows) {
        await client.query(
          `INSERT INTO push_notifications (recipient_address, market_id, type, payload, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [
            row.bettor_address, market_id, 'market_cancelled',
            JSON.stringify({ market_id, reason, refund: true }),
          ],
        );
      }

      await client.query('COMMIT');
      logger.info(
        `MarketCancelled ${market_id} reason='${reason}', enqueued refund notifications for ${bettorsResult.rowCount} bettors`,
      );
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Failed to handle MarketCancelled event ${tx_hash}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  async handleWinningsClaimed(event: WinningsClaimedEvent): Promise<void> {
    const { bettor_address, market_id, amount_won, claimed_at } = event;

    const claimedAt = new Date(claimed_at * 1000);

    await prisma.bet.updateMany({
      where: { bettor_address, market_id, claimed: false },
      data: { claimed: true, claimed_at: claimedAt, payout: amount_won },
    });

    logger.info(`WinningsClaimed processed for bettor ${bettor_address} on market ${market_id}`);
  }

  // ── Backfill ───────────────────────────────────────────────────────────────

  /**
   * Backfill historical ledger ranges in ascending order, processing in
   * bounded batches to avoid OOM. Events are deduplicated via ON CONFLICT
   * DO UPDATE, and the checkpoint is only advanced after the final ledger.
   */
  async backfillLedgerRange(
    fromLedger: number,
    toLedger: number,
    batchSize: number,
  ): Promise<void> {
    if (fromLedger > toLedger) {
      throw new Error(`Invalid ledger range: fromLedger (${fromLedger}) > toLedger (${toLedger})`);
    }
    if (batchSize <= 0) {
      throw new Error(`Invalid batchSize: ${batchSize}`);
    }

    logger.info(`Starting backfill from ledger ${fromLedger} to ${toLedger} (batchSize=${batchSize})`);

    let processed = 0;

    for (let start = fromLedger; start <= toLedger; start += batchSize) {
      const end = Math.min(start + batchSize - 1, toLedger);
      const events = await this.fetchEventsForRange(start, end);

      for (const event of events) {
        await this.persistEventDeduped(event);
      }

      processed += end - start + 1;

      if (processed % 1000 === 0 || end === toLedger) {
        logger.info(`Backfill progress: processed up to ledger ${end} (${processed} ledgers)`);
      }
    }

    await this.updateCheckpoint(toLedger);
    logger.info(`Backfill complete. Checkpoint updated to ledger ${toLedger}`);
  }

  private async fetchEventsForRange(
    startLedger: number,
    endLedger: number,
  ): Promise<SorobanRpc.Api.EventResponse[]> {
    const events: SorobanRpc.Api.EventResponse[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.server.getEvents({
        startLedger,
        filters: [{ type: 'contract', contractIds: [this.config.factoryContractId] }],
        cursor,
        limit: 200,
      });

      for (const event of response.events) {
        if (event.ledger <= endLedger) {
          events.push(event);
        }
      }

      cursor = response.cursor;
      if (response.events.length === 0) break;
    } while (cursor);

    return events;
  }

  private async persistEventDeduped(event: SorobanRpc.Api.EventResponse): Promise<void> {
    const topics = event.topic.map((t) => scValToNative(t));
    const eventName = String(topics[0]);
    const data = scValToNative(event.value) as Record<string, unknown>;

    await prisma.$executeRaw`
      INSERT INTO "IndexedEvent" ("tx_hash", "event_index", "ledger", "event_name", "payload", "created_at")
      VALUES (${event.txHash}, ${event.id}, ${event.ledger}, ${eventName}, ${JSON.stringify(
        data,
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      )}::jsonb, NOW())
      ON CONFLICT ("tx_hash", "event_index") DO UPDATE
      SET "ledger" = EXCLUDED."ledger",
          "event_name" = EXCLUDED."event_name",
          "payload" = EXCLUDED."payload"
    `;
  }

  private async updateCheckpoint(ledger: number): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO "IndexerCheckpoint" ("id", "last_ledger", "updated_at")
      VALUES ('default', ${ledger}, NOW())
      ON CONFLICT ("id") DO UPDATE
      SET "last_ledger" = EXCLUDED."last_ledger",
          "updated_at" = EXCLUDED."updated_at"
    `;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

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
