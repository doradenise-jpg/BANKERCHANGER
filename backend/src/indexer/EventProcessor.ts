import { pool } from '../config/db';
import { cacheDeletePattern } from '../services/cache.service';

export interface RawStellarEvent {
  contract_address: string;
  event_type: string;
  topics: string[];
  data: string;
  ledger_sequence: number;
  ledger_close_time: string;
  tx_hash: string;
}

export interface EventProcessor {
  process(event: RawStellarEvent): Promise<void>;
}

function parsePayload(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export class StellarEventProcessor implements EventProcessor {
  async process(event: RawStellarEvent): Promise<void> {
    try {
      const eventType = event.event_type;

      if (eventType === 'market_created') {
        await this.handleMarketCreated(event);
      } else if (eventType === 'bet_placed') {
        await this.handleBetPlaced(event);
      } else if (eventType === 'market_locked') {
        await this.handleMarketLocked(event);
      } else if (eventType === 'market_resolved') {
        await this.handleMarketResolved(event);
      } else if (eventType === 'market_cancelled') {
        await this.handleMarketCancelled(event);
      } else if (eventType === 'winnings_claimed') {
        await this.handleWinningsClaimed(event);
      } else if (eventType === 'refund_claimed') {
        await this.handleRefundClaimed(event);
      }
    } catch (err) {
      console.error(`Error processing event ${event.tx_hash}:`, err);
    }
  }

  private async handleMarketCreated(event: RawStellarEvent): Promise<void> {
    const p = parsePayload(event.data);

    try {
      const marketData = {
        market_id: p.market_id,
        contract_address: event.contract_address,
        match_id: p.match_id ?? '',
        fighter_a: p.fighter_a ?? '',
        fighter_b: p.fighter_b ?? '',
        weight_class: p.weight_class ?? '',
        title_fight: p.title_fight ?? false,
        venue: p.venue ?? '',
        scheduled_at: p.scheduled_at ?? new Date(),
        fee_bps: p.fee_bps ?? 200,
        lock_before_secs: p.lock_before_secs ?? 3600,
        status: 'open',
        ledger_sequence: event.ledger_sequence,
      };

      await pool.query(
        `INSERT INTO markets
           (market_id, contract_address, match_id, fighter_a, fighter_b,
            weight_class, title_fight, venue, scheduled_at, fee_bps, lock_before_secs, status, ledger_sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (market_id) DO NOTHING`,
        [
          marketData.market_id,
          marketData.contract_address,
          marketData.match_id,
          marketData.fighter_a,
          marketData.fighter_b,
          marketData.weight_class,
          marketData.title_fight,
          marketData.venue,
          marketData.scheduled_at,
          marketData.fee_bps,
          marketData.lock_before_secs,
          marketData.status,
          marketData.ledger_sequence,
        ]
      );

      console.log(`[Indexer] Market created: ${marketData.market_id}`);
    } catch (err) {
      console.error(`[Indexer] Error handling MarketCreated event:`, err);
      throw err;
    }
  }

  private async handleBetPlaced(event: RawStellarEvent): Promise<void> {
    const p = parsePayload(event.data);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO bets
           (market_id, bettor_address, side, amount, amount_xlm, placed_at, tx_hash, ledger_sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [
          p.market_id,
          p.bettor_address,
          p.side,
          p.amount,
          Number(p.amount) / 10_000_000,
          p.placed_at ?? new Date(),
          event.tx_hash,
          event.ledger_sequence,
        ]
      );
      const col =
        p.side === 'fighter_a' ? 'pool_a' : p.side === 'fighter_b' ? 'pool_b' : 'pool_draw';
      await client.query(
        `UPDATE markets
          SET ${col}      = ${col} + $1,
              total_pool  = total_pool + $1,
              updated_at  = NOW()
        WHERE market_id   = $2`,
        [p.amount, p.market_id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async handleMarketLocked(event: RawStellarEvent): Promise<void> {
    const p = parsePayload(event.data);
    await pool.query(`UPDATE markets SET status = 'locked', updated_at = NOW() WHERE market_id = $1`, [
      p.market_id,
    ]);
  }

  private async handleMarketResolved(event: RawStellarEvent): Promise<void> {
    const p = parsePayload(event.data);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE markets
          SET status = 'resolved', outcome = $1, resolved_at = $2, oracle_used = $3, updated_at = NOW()
        WHERE market_id = $4`,
        [p.outcome, event.ledger_close_time, p.oracle_address ?? null, p.market_id]
      );

      await client.query(
        `INSERT INTO oracle_reports
           (match_id, oracle_address, outcome, reported_at, signature, accepted, tx_hash)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6)
         ON CONFLICT DO NOTHING`,
        [p.match_id ?? '', p.oracle_address ?? '', p.outcome ?? '', event.ledger_close_time, p.signature ?? '', event.tx_hash]
      );

      const { rows: bettors } = await client.query(`SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`, [
        p.market_id,
      ]);

      for (const bettor of bettors) {
        await client.query(
          `INSERT INTO notification_jobs (bettor_address, market_id, job_type, status, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [bettor.bettor_address, p.market_id, 'market_resolved', 'pending']
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await cacheDeletePattern(`market:${p.market_id}*`);
    await cacheDeletePattern(`markets:*`);
  }

  private async handleMarketCancelled(event: RawStellarEvent): Promise<void> {
    const p = parsePayload(event.data);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`UPDATE markets SET status = 'cancelled', updated_at = NOW() WHERE market_id = $1`, [
        p.market_id,
      ]);

      const { rows: bettors } = await client.query(`SELECT DISTINCT bettor_address FROM bets WHERE market_id = $1`, [
        p.market_id,
      ]);

      for (const bettor of bettors) {
        await client.query(
          `INSERT INTO notification_jobs (bettor_address, market_id, job_type, status, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [bettor.bettor_address, p.market_id, 'market_cancelled', 'pending']
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async handleWinningsClaimed(event: RawStellarEvent): Promise<void> {
    const p = parsePayload(event.data);
    await pool.query(
      `UPDATE bets
        SET claimed = TRUE, claimed_at = NOW(), payout = $1
      WHERE market_id = $2 AND bettor_address = $3`,
      [p.payout ?? null, p.market_id, p.bettor_address]
    );
  }

  private async handleRefundClaimed(event: RawStellarEvent): Promise<void> {
    const p = parsePayload(event.data);
    await pool.query(
      `UPDATE bets
        SET claimed = TRUE, claimed_at = NOW(), payout = $1
      WHERE market_id = $2 AND bettor_address = $3`,
      [p.refund_amount ?? null, p.market_id, p.bettor_address]
    );
  }
}
