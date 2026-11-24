import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { dbQueryDuration, dbConnections } from '../services/metrics.service';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://bankerchanger:bankerchanger@localhost:5432/bankerchanger';

const parseNumber = (value: string | undefined, defaultValue: number): number => {
  if (value) {
    const num = Number(value);
    if (!isNaN(num) && num > 0) {
      return num;
    }
  }
  return defaultValue;
};

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: parseNumber(process.env.DB_POOL_MAX, 10),
  idleTimeoutMillis: parseNumber(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: parseNumber(process.env.DB_POOL_CONNECTION_TIMEOUT_MS, 5000),
});

const deriveOperation = (query: unknown): string => {
  let sql = '';
  if (typeof query === 'string') {
    sql = query;
  } else if (query && typeof query === 'object' && 'text' in query) {
    const text = (query as { text?: unknown }).text;
    if (typeof text === 'string') {
      sql = text;
    }
  }
  const match = sql.trim().match(/^([a-zA-Z]+)/);
  if (!match) {
    return 'other';
  }
  const verb = match[1].toLowerCase();
  switch (verb) {
    case 'select':
    case 'insert':
    case 'update':
    case 'delete':
      return verb;
    default:
      return 'other';
  }
};

const updateConnectionGauge = (): void => {
  dbConnections.set({ state: 'total' }, pool.totalCount);
  dbConnections.set({ state: 'idle' }, pool.idleCount);
  dbConnections.set({ state: 'waiting' }, pool.waitingCount);
};

const observeQuery = <T extends QueryResultRow = any>(
  query: unknown,
  executor: () => Promise<QueryResult<T>>,
): Promise<QueryResult<T>> => {
  const operation = deriveOperation(query);
  const end = dbQueryDuration.startTimer({ operation });
  return executor().finally(() => {
    end();
    updateConnectionGauge();
  });
};

const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<QueryResult<any>>;

(pool as any).query = (...args: any[]): Promise<QueryResult<any>> => {
  const query = args[0];
  return observeQuery(query, () => originalQuery(...args));
};

const originalConnect = pool.connect.bind(pool) as (...args: any[]) => Promise<PoolClient>;

(pool as any).connect = (...args: any[]): Promise<PoolClient> => {
  return originalConnect(...args).then((client) => {
    updateConnectionGauge();

    const originalClientQuery = client.query.bind(client) as (...qArgs: any[]) => Promise<QueryResult<any>>;

    (client as any).query = (...qArgs: any[]): Promise<QueryResult<any>> => {
      const query = qArgs[0];
      return observeQuery(query, () => originalClientQuery(...qArgs));
    };

    const originalRelease = client.release.bind(client) as (...rArgs: any[]) => void;

    (client as any).release = (...rArgs: any[]): void => {
      const result = originalRelease(...rArgs);
      updateConnectionGauge();
      return result;
    };

    return client;
  });
};

pool.on('connect', () => {
  updateConnectionGauge();
});

pool.on('acquire', () => {
  updateConnectionGauge();
});

pool.on('release', () => {
  updateConnectionGauge();
});

pool.on('remove', () => {
  updateConnectionGauge();
});

updateConnectionGauge();