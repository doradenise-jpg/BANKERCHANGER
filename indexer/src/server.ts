import express, { Request, Response } from 'express';
import cors from 'cors';
import { getInvoices, getInvoiceById } from './db';
import { getHealthState } from './health';
import { version } from '../package.json';

const app = express();

app.use(cors());
app.use(express.json());

// Health check endpoint for K8s liveness/readiness probes
app.get('/health', (req: Request, res: Response) => {
  try {
    const { lastLedger, cursorAge } = getHealthState();
    
    res.json({
      status: 'ok',
      lastLedger,
      cursorAge,
      version,
    });
  } catch (err: any) {
    res.status(503).json({
      status: 'error',
      error: err.message,
    });
  }
});

app.get('/invoices', (req: Request, res: Response) => {
  try {
    const { status, freelancer, payer, funder } = req.query;
    
    // Requirements say "?funder=" but the DB has "payer"
    // We'll treat funder and payer as interchangeable for this query
    const filterPayer = (payer as string) || (funder as string);

    const invoices = getInvoices({
      status: status as string,
      freelancer: freelancer as string,
      payer: filterPayer
    });

    res.json({ success: true, data: invoices });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/invoice/:id', (req: Request, res: Response): void => {
  try {
    const { id } = req.params;
    const invoice = getInvoiceById(id as string);
    
    if (!invoice) {
      res.status(404).json({ success: false, error: 'Invoice not found' });
      return;
    }

    res.json({ success: true, data: invoice });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default app;
