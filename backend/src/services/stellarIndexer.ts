import { Pool } from 'pg';
import { SorobanEvent } from '../types/soroban';
import { logger } from '../utils/logger';

export class StellarIndexer {
  constructor(private pool: Pool) {}

  async handleBetPlaced(event: SorobanEvent): Promise<void> {
    const { bet_id, market_id, bettor, amount, outcome } = event.data;

    await this.pool.query(
      `INSERT INTO bets (bet_id, market_id, bettor, amount, outcome, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (bet_id) DO NOTHING`,
      [bet_id, market_id, bettor, amount, outcome]
    );

    logger.info(`Indexed BetPlaced event for bet ${bet_id}`);
  }

  async handleMarketCreated(event: SorobanEvent): Promise<void> {
    const { market_id, creator, question, end_time } = event.data;

    await this.pool.query(
      `INSERT INTO markets (market_id, creator, question, end_time, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
       ON CONFLICT (market_id) DO NOTHING`,
      [market_id, creator, question, end_time]
    );

    logger.info(`Indexed MarketCreated event for market ${market_id}`);
  }

  async handleMarketLocked(event: SorobanEvent): Promise<void> {
    const { market_id } = event.data;

    await this.pool.query(
      `UPDATE markets
       SET status = 'locked', updated_at = NOW()
       WHERE market_id = $1`,
      [market_id]
    );

    logger.info(`Indexed MarketLocked event for market ${market_id}`);
  }
}
