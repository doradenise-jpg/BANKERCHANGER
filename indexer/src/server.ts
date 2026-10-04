import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { Server } from 'http';
import { getInvoices, getInvoiceById } from './db';
import { getPollerHealth } from './poller';
import { isLive, isReady, getReadinessDetails, getHealthResponse } from './health';

const app = express();

app.use(cors());
app.use(express.json());

// ── In-Flight Request Tracking & Graceful Shutdown (#698) ────────────────────

let activeRequestsCount = 0;
let isShuttingDown = false;

export const serverMetrics = {
  indexer_graceful_shutdown_duration_seconds: 0,
};

export function getActiveRequestsCount(): number {
  return activeRequestsCount;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (isShuttingDown) {
    res.setHeader('Connection', 'close');
    res.status(503).json({ error: 'Server is shutting down' });
    return;
  }

  activeRequestsCount++;
  const decrement = () => {
    activeRequestsCount = Math.max(0, activeRequestsCount - 1);
    res.removeListener('finish', decrement);
    res.removeListener('close', decrement);
  };

  res.on('finish', decrement);
  res.on('close', decrement);
  next();
});

/**
 * Gracefully shuts down the HTTP server by waiting for in-flight requests to complete.
 * Waits up to timeoutMs (default 30s).
 */
export async function gracefulShutdown(
  httpServer?: Server,
  timeoutMs = 30000,
): Promise<{ abortedRequests: number; durationSeconds: number }> {
  isShuttingDown = true;
  const startTime = Date.now();
  let abortedRequests = 0;

  logger.info({ activeRequests: activeRequestsCount, timeoutMs }, 'SIGTERM received: beginning graceful shutdown, stopping new connections');

  if (httpServer) {
    httpServer.close();
  }

  const deadline = Date.now() + timeoutMs;
  while (activeRequestsCount > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (activeRequestsCount > 0) {
    abortedRequests = activeRequestsCount;
    logger.warn({ abortedRequests, timeoutMs }, `Shutdown deadline reached: forced shutdown with ${abortedRequests} aborted requests`);
  } else {
    logger.info('All in-flight requests drained cleanly');
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  serverMetrics.indexer_graceful_shutdown_duration_seconds = durationSeconds;
  logger.info(
    {
      durationSeconds,
      metric: 'indexer_graceful_shutdown_duration_seconds',
      value: durationSeconds,
    },
    `Graceful shutdown completed in ${durationSeconds.toFixed(2)}s`,
  );

  return { abortedRequests, durationSeconds };
}

// ── Health Probes ─────────────────────────────────────────────────────────────

app.get('/healthz/live', (req: Request, res: Response) => {
  try {
    const live = isLive();
    const statusCode = live ? 200 : 503;
    
    res.status(statusCode).json({
      status: live ? 'alive' : 'dead',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ 
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get('/healthz/ready', (req: Request, res: Response) => {
  try {
    const ready = isReady();
    const details = getReadinessDetails();
    const statusCode = ready ? 200 : 503;
    
    res.status(statusCode).json({
      status: ready ? 'ready' : 'not_ready',
      ready,
      ledger_lag: details.ledger_lag,
      last_processed_ledger: details.last_processed_ledger,
      latest_network_ledger: details.latest_network_ledger,
      lastLedger: details.lastLedger,
      cursorAge: details.cursorAge,
      maxCursorAge: details.maxCursorAge,
      reasons: details.reasons,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(503).json({ 
      status: 'error',
      ready: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Unified health endpoint (Issue #695)
 * Returns { status, ledger_lag, last_processed_ledger, latest_network_ledger }
 * alongside detailed poller health metrics.
 */
app.get('/health', (req: Request, res: Response) => {
  try {
    const health = getPollerHealth();
    const ready = isReady();
    const healthSummary = getHealthResponse();
    
    const statusCode = (health.isRunning && ready) ? 200 : 503;
    
    res.status(statusCode).json({
      success: statusCode === 200,
      status: healthSummary.status,
      ledger_lag: healthSummary.ledger_lag,
      last_processed_ledger: healthSummary.last_processed_ledger,
      latest_network_ledger: healthSummary.latest_network_ledger,
      ready,
      poller: {
        isRunning: health.isRunning,
        consecutiveFailures: health.consecutiveFailures,
        lastError: health.lastError,
        lastErrorAt: health.lastErrorAt,
        lastSuccessfulPollAt: health.lastSuccessfulPollAt,
        eventsProcessed: health.eventsProcessed,
        reorgsDetected: health.reorgsDetected,
        lastReorgAt: health.lastReorgAt,
        ledgerGapsDetected: health.ledgerGapsDetected,
        lastLedgerGapAt: health.lastLedgerGapAt,
      },
    });
  } catch (err: any) {
    res.status(500).json({ 
      success: false, 
      status: 'error',
      error: err.message 
    });
  }
});

app.get('/invoices', (req: Request, res: Response) => {
  try {
    const { status, freelancer, payer, funder } = req.query;
    const filterPayer = (payer as string) || (funder as string);

    const invoices = getInvoices({
      status: status as string,
      freelancer: freelancer as string,
      payer: filterPayer,
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
