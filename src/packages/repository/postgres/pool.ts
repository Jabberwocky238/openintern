import { Pool, type PoolClient, type PoolConfig, type QueryResult } from 'pg';
import { logger } from '@openintern/utils';
import { POSTGRES_SCHEMA_STATEMENTS } from './schema.js';

export interface PostgresOptions {
  connectionString?: string;
  maxPoolSize?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  sslEnabled?: boolean;
}

const DEFAULT_POSTGRES_OPTIONS: Required<Omit<PostgresOptions, 'connectionString'>> = {
  maxPoolSize: 20,
  idleTimeoutMs: 30000,
  connectionTimeoutMs: 5000,
  sslEnabled: false,
};

let sharedPool: Pool | null = null;
let migrationPromise: Promise<void> | null = null;
const MIGRATION_LOCK_NAMESPACE = 2026;
const MIGRATION_LOCK_KEY = 210;

function resolveConnectionString(options: PostgresOptions, env: NodeJS.ProcessEnv): string {
  const url = options.connectionString ?? env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is required for Postgres runtime. Provide it in environment or server config.'
    );
  }
  return url;
}

function buildPoolConfig(options: PostgresOptions): PoolConfig {
  const connectionString = resolveConnectionString(options, process.env);
  const sslFromEnv = process.env['PGSSLMODE'] === 'require' || process.env['DATABASE_SSL'] === 'true';
  const sslEnabled = options.sslEnabled ?? sslFromEnv ?? DEFAULT_POSTGRES_OPTIONS.sslEnabled;
  return {
    connectionString,
    max: options.maxPoolSize ?? DEFAULT_POSTGRES_OPTIONS.maxPoolSize,
    idleTimeoutMillis: options.idleTimeoutMs ?? DEFAULT_POSTGRES_OPTIONS.idleTimeoutMs,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_POSTGRES_OPTIONS.connectionTimeoutMs,
    ...(sslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

export function createPostgresPool(options: PostgresOptions = {}): Pool {
  return new Pool(buildPoolConfig(options));
}

export function getPostgresPool(options: PostgresOptions = {}): Pool {
  if (!sharedPool) {
    sharedPool = createPostgresPool(options);
  }
  return sharedPool;
}

export async function runPostgresMigrations(pool: Pool): Promise<void> {
  if (migrationPromise) {
    return migrationPromise;
  }
  migrationPromise = (async () => {
    const client = await pool.connect();
    await client.query('SELECT pg_advisory_lock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
    try {
      for (const statement of POSTGRES_SCHEMA_STATEMENTS) {
        await client.query(statement);
      }
      logger.info('Postgres schema is ready');
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_KEY]);
      } catch (unlockError) {
        logger.warn('Failed to release postgres migration lock', {
          error: unlockError instanceof Error ? unlockError.message : String(unlockError),
        });
      }
      client.release();
    }
  })();
  try {
    await migrationPromise;
  } catch (error) {
    migrationPromise = null;
    throw error;
  }
}

export async function closeSharedPostgresPool(): Promise<void> {
  if (!sharedPool) {
    return;
  }
  await sharedPool.end();
  sharedPool = null;
  migrationPromise = null;
}

export async function query<T extends Record<string, unknown>>(
  statement: string,
  params: unknown[] = [],
  pool?: Pool
): Promise<QueryResult<T>> {
  const db = pool ?? getPostgresPool();
  return db.query<T>(statement, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>, pool?: Pool): Promise<T> {
  const db = pool ?? getPostgresPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}




