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

const instrumentClient = (client: PoolClient): PoolClient => {
  const originalClientQuery = client.query.bind(client) as (...args: any[]) => any;
  (client as any).query = (...args: any[]): any => {
    const query = args[0];
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] === 'function') {
      const callback = args[callbackIndex];
      const end = dbQueryDuration.startTimer({ operation: deriveOperation(query) });
      args[callbackIndex] = (...callbackArgs: any[]) => {
        end();
        updateConnectionGauge();
        return callback(...callbackArgs);
      };
      return originalClientQuery(...args);
    }
    return observeQuery(query, () => originalClientQuery(...args));
  };

  const originalRelease = client.release.bind(client) as (...args: any[]) => void;
  (client as any).release = (...args: any[]): void => {
    const result = originalRelease(...args);
    updateConnectionGauge();
    return result;
  };
  return client;
};

const originalConnect = pool.connect.bind(pool) as (...args: any[]) => any;

(pool as any).connect = (...args: any[]): any => {
  const callbackIndex = args.length - 1;
  if (typeof args[callbackIndex] === 'function') {
    const callback = args[callbackIndex];
    args[callbackIndex] = (error: Error | undefined, client: PoolClient, release: () => void) => {
      if (client) instrumentClient(client);
      updateConnectionGauge();
      return callback(error, client, release);
    };
    return originalConnect(...args);
  }
  return originalConnect(...args).then((client: PoolClient) => {
    updateConnectionGauge();
    return instrumentClient(client);
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