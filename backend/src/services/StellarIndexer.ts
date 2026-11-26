import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { SorobanRpc, scValToNative } from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

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

export class StellarIndexer {
  private server: SorobanRpc.Server;
  private contractId: string;

  constructor(rpcUrl: string, contractId: string, private db?: Pool) {
    this.server = new SorobanRpc.Server(rpcUrl);
    this.contractId = contractId;
  }

  async handleBetPlaced(event: BetPlacedEvent): Promise<void> {
    if (!this.db) throw new Error('db pool required for handleBetPlaced');
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
        [bettor_address, market_id, side, amount_stroops, amountXlm, placed_at, tx_hash]
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
        [amountStroops.toString(), market_id]
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
    if (!this.db) throw new Error('db pool required for handleMarketLocked');
    const { market_id, tx_hash } = event;

    try {
      const result = await this.db.query(
        `UPDATE markets
         SET status = 'locked',
             updated_at = NOW()
         WHERE market_id = $1`,
        [market_id]
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
    if (!this.db) throw new Error('db pool required for handleMarketResolved');
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
         SET status = 'resolved',
             outcome = $1,
             resolved_at = $2,
             oracle_used = $3
         WHERE market_id = $4`,
        [normalizedOutcome, resolved_at, oracle_address, market_id]
      );

      const bettorsResult = await client.query(
        `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`,
        [market_id]
      );

      for (const row of bettorsResult.rows) {
        await client.query(
          `INSERT INTO push_notifications (recipient_address, market_id, type, payload, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            row.bettor_address,
            market_id,
            'market_resolved',
            JSON.stringify({ market_id, outcome: normalizedOutcome, oracle_role }),
            resolved_at,
          ]
        );
      }

      await client.query('COMMIT');
      logger.info(
        `MarketResolved ${market_id} outcome=${normalizedOutcome} oracle=${oracle_address} (${oracle_role}), notified ${bettorsResult.rowCount} bettors`
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
    if (!this.db) throw new Error('db pool required for handleMarketCancelled');
    const { market_id, reason, tx_hash } = event;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const updateResult = await client.query(
        `UPDATE markets
         SET status = 'cancelled',
             cancel_reason = $1,
             updated_at = NOW()
         WHERE market_id = $2`,
        [reason, market_id]
      );

      if (updateResult.rowCount === 0) {
        await client.query('ROLLBACK');
        logger.warn(`MarketCancelled ${tx_hash}: market ${market_id} not found, skipping`);
        return;
      }

      const bettorsResult = await client.query(
        `SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`,
        [market_id]
      );

      for (const row of bettorsResult.rows) {
        await client.query(
          `INSERT INTO push_notifications (recipient_address, market_id, type, payload, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [
            row.bettor_address,
            market_id,
            'market_cancelled',
            JSON.stringify({ market_id, reason, refund: true }),
          ]
        );
      }

      await client.query('COMMIT');
      logger.info(
        `MarketCancelled ${market_id} reason='${reason}', enqueued refund notifications for ${bettorsResult.rowCount} bettors`
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
      where: {
        bettor_address,
        market_id,
        claimed: false,
      },
      data: {
        claimed: true,
        claimed_at: claimedAt,
        payout: amount_won,
      },
    });

    logger.info(
      `WinningsClaimed processed for bettor ${bettor_address} on market ${market_id}`
    );
  }

  async processEvent(event: SorobanRpc.Api.EventResponse): Promise<void> {
    const topics = event.topic.map((t) => scValToNative(t));
    const eventName = topics[0];
    const data = scValToNative(event.value) as Record<string, unknown>;

    switch (eventName) {
      case 'WinningsClaimed':
        await this.handleWinningsClaimed({
          bettor_address: String(data.bettor_address),
          market_id: Number(data.market_id),
          amount_won: BigInt(String(data.amount_won)),
          fee_deducted: BigInt(String(data.fee_deducted)),
          claimed_at: Number(data.claimed_at),
        });
        break;
      default:
        logger.debug(`Unhandled event: ${String(eventName)}`);
    }
  }

  /**
   * Backfill historical ledger ranges in ascending order, processing in
   * bounded batches to avoid OOM. Events are deduplicated via ON CONFLICT
   * DO UPDATE, and the checkpoint is only advanced after the final ledger.
   */
  async backfillLedgerRange(
    fromLedger: number,
    toLedger: number,
    batchSize: number
  ): Promise<void> {
    if (fromLedger > toLedger) {
      throw new Error(
        `Invalid ledger range: fromLedger (${fromLedger}) > toLedger (${toLedger})`
      );
    }
    if (batchSize <= 0) {
      throw new Error(`Invalid batchSize: ${batchSize}`);
    }

    logger.info(
      `Starting backfill from ledger ${fromLedger} to ${toLedger} (batchSize=${batchSize})`
    );

    let processed = 0;

    for (let start = fromLedger; start <= toLedger; start += batchSize) {
      const end = Math.min(start + batchSize - 1, toLedger);

      const events = await this.fetchEventsForRange(start, end);

      for (const event of events) {
        await this.persistEventDeduped(event);
      }

      processed += end - start + 1;

      if (processed % 1000 === 0 || end === toLedger) {
        logger.info(
          `Backfill progress: processed up to ledger ${end} (${processed} ledgers)`
        );
      }
    }

    await this.updateCheckpoint(toLedger);

    logger.info(`Backfill complete. Checkpoint updated to ledger ${toLedger}`);
  }

  private async fetchEventsForRange(
    startLedger: number,
    endLedger: number
  ): Promise<SorobanRpc.Api.EventResponse[]> {
    const events: SorobanRpc.Api.EventResponse[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.server.getEvents({
        startLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
          },
        ],
        cursor,
        limit: 200,
      });

      for (const event of response.events) {
        if (event.ledger <= endLedger) {
          events.push(event);
        }
      }

      cursor = response.cursor;
      if (response.events.length === 0) {
        break;
      }
    } while (cursor);

    return events;
  }

  private async persistEventDeduped(
    event: SorobanRpc.Api.EventResponse
  ): Promise<void> {
    const topics = event.topic.map((t) => scValToNative(t));
    const eventName = String(topics[0]);
    const data = scValToNative(event.value) as Record<string, unknown>;

    await prisma.$executeRaw`
      INSERT INTO "IndexedEvent" ("tx_hash", "event_index", "ledger", "event_name", "payload", "created_at")
      VALUES (${event.txHash}, ${event.id}, ${event.ledger}, ${eventName}, ${JSON.stringify(
        data,
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v)
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
}
