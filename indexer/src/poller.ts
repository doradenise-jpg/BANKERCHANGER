import { rpc, scValToNative } from '@stellar/stellar-sdk';
import { getCursor, saveCursor, upsertInvoice } from './db';
import { updateLastLedger } from './health';
import dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.INVOICE_CONTRACT_ID || 'C_MOCK_INVOICE_CONTRACT_ID'; // Replace with real one

const server = new rpc.Server(RPC_URL);

export async function pollEvents() {
  console.log('Started polling Horizon for contract events...');

  let cursor = (await getCursor()) || '';

  // Polling loop
  setInterval(async () => {
    try {
      // Soroban getEvents requests
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
          processEvent(event);
          // Update last ledger from event
          if (event.ledger) {
            updateLastLedger(event.ledger);
          }
        }
        cursor = response.cursor;
        await saveCursor(cursor);
      }
    } catch (err) {
      console.error('Error fetching events:', err);
    }
  }, 5000); // Poll every 5 seconds
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

export function processEvent(event: rpc.Api.EventResponse) {
  // Topics are scVals, typically symbol strings
  const topics = event.topic.map(t => {
    try {
      return scValToNative(t);
    } catch {
      return null;
    }
  });

  const eventType = topics[0]; // e.g. 'submitted', 'funded', 'paid', 'defaulted'
  if (!eventType) return;

  try {
    const data = scValToNative(event.value);
    
    // Assume data contains { id, freelancer, payer, amount, dueDate } for 'submitted'
    // and just { id } for status changes. This is dependent on contract implementation.
    
    if (eventType === 'submitted') {
      upsertInvoice({
        id: data.id,
        freelancer: data.freelancer || '',
        payer: data.payer || '',
        amount: data.amount || 0,
        due_date: data.dueDate || new Date().toISOString(),
        status: 'Pending'
      });
      console.log(`Processed submitted event for invoice ${data.id}`);
    } else if (eventType === 'funded') {
      upsertInvoice({
        id: data.id || data,
        freelancer: '', payer: '', amount: 0, due_date: '',
        status: 'Funded'
      });
      console.log(`Processed funded event for invoice ${data.id || data}`);
    } else if (eventType === 'paid') {
      upsertInvoice({
        id: data.id || data,
        freelancer: '', payer: '', amount: 0, due_date: '',
        status: 'Paid'
      });
      console.log(`Processed paid event for invoice ${data.id || data}`);
    } else if (eventType === 'defaulted') {
      upsertInvoice({
        id: data.id || data,
        freelancer: '', payer: '', amount: 0, due_date: '',
        status: 'Defaulted'
      });
      console.log(`Processed defaulted event for invoice ${data.id || data}`);
    }
  } catch (err) {
    console.error(`Failed to process event ${event.id}:`, err);
  }
}
