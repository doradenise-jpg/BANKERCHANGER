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
}
