import { Pool } from 'pg';
import { Server } from '@stellar/stellar-sdk/rpc';
import { processLedger } from './processLedger';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const GENESIS_LEDGER = Number(process.env.GENESIS_LEDGER ?? 1);
const LOG_EVERY = 100;

let running = false;

async function loadCheckpoint(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ last_ledger: number }>(
    'SELECT last_ledger FROM indexer_checkpoint WHERE id = 1'
  );
  if (rows.length > 0 && rows[0].last_ledger != null) {
    return Number(rows[0].last_ledger);
  }
  return GENESIS_LEDGER;
}

async function saveCheckpoint(pool: Pool, ledger: number): Promise<void> {
  await pool.query(
    `INSERT INTO indexer_checkpoint (id, last_ledger, updated_at)
     VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET last_ledger = EXCLUDED.last_ledger, updated_at = NOW()`,
    [ledger]
  );
}

async function getLatestLedger(server: Server): Promise<number> {
  const latest = await server.getLatestLedger();
  return latest.sequence;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startIndexer(pool: Pool, server: Server): Promise<void> {
  if (running) {
    console.warn('[indexer] startIndexer called while already running; ignoring');
    return;
  }
  running = true;

  try {
    let lastLedger = await loadCheckpoint(pool);
    console.log(`[indexer] starting from ledger ${lastLedger}`);

    while (running) {
      const latestLedger = await getLatestLedger(server);

      if (latestLedger <= lastLedger) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      for (let ledger = lastLedger + 1; ledger <= latestLedger; ledger++) {
        await processLedger(pool, server, ledger);
        await saveCheckpoint(pool, ledger);
        lastLedger = ledger;

        if (ledger % LOG_EVERY === 0) {
          console.log(`[indexer] processed ledger ${ledger}`);
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    console.error('[indexer] fatal error, shutting down:', err);
    running = false;
    throw err;
  }
}

export function stopIndexer(): void {
  running = false;
}
