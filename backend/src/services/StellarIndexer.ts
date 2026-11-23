import { Pool } from 'pg';
import { logger } from '../utils/logger';

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

export class StellarIndexer {
  constructor(private db: Pool) {}

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
}
