import { rpc, scValToNative } from '@stellar/stellar-sdk';
import { getCursor, saveCursor } from './db';
import dotenv from 'dotenv';
import { RawStellarEvent, StellarEventProcessor } from '../../backend/src/indexer/EventProcessor';

dotenv.config();

const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.INVOICE_CONTRACT_ID || 'C_MOCK_INVOICE_CONTRACT_ID';

const server = new rpc.Server(RPC_URL);
const eventProcessor = new StellarEventProcessor();

export async function pollEvents() {
  console.log('Started polling Horizon for contract events...');

  let cursor = (await getCursor()) || '';

  setInterval(async () => {
    try {
      const request: rpc.Api.GetEventsRequest = cursor
        ? {
            cursor,
            filters: [
              {
                type: 'contract',
                contractIds: [CONTRACT_ID],
                topics: [['*']]
              }
            ],
            limit: 100
          }
        : {
            startLedger: await getLatestLedger(),
            filters: [
              {
                type: 'contract',
                contractIds: [CONTRACT_ID],
                topics: [['*']]
              }
            ],
            limit: 100
          };

      const response = await server.getEvents(request);

      if (response.events && response.events.length > 0) {
        for (const event of response.events) {
          await processEvent(event);
        }
        cursor = response.cursor;
        await saveCursor(cursor);
      }
    } catch (err) {
      console.error('Error fetching events:', err);
    }
  }, 5000);
}

async function getLatestLedger(): Promise<number> {
  try {
    const health = await server.getLatestLedger();
    return health.sequence;
  } catch (err) {
    console.error('Could not get latest ledger', err);
    return 1;
  }
}

async function processEvent(event: rpc.Api.EventResponse) {
  try {
    const topics = event.topic.map(t => {
      try {
        return scValToNative(t);
      } catch {
        return null;
      }
    });

    const eventType = topics[0];
    if (!eventType) return;

    const data = scValToNative(event.value);

    const rawEvent: RawStellarEvent = {
      contract_address: typeof event.contractId === 'string' ? event.contractId : event.contractId?.toString() || '',
      event_type: String(eventType),
      topics: topics.map(t => String(t ?? '')),
      data: JSON.stringify(data),
      ledger_sequence: event.ledger,
      ledger_close_time: event.ledgerClosedAt,
      tx_hash: event.txHash
    };

    await eventProcessor.process(rawEvent);
  } catch (err) {
    console.error(`Failed to process event:`, err);
  }
}
