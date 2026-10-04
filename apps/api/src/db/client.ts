// pg via DATABASE_URL (Neon). With no DATABASE_URL, an in-memory PGlite stands in
// so the app and tests run locally. That fallback is for development only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../env.js';

type Row = Record<string, any>;
interface Driver {
  query(sql: string, params: unknown[]): Promise<Row[]>;
  exec(sql: string): Promise<void>;
  kind: 'neon' | 'pglite';
}

export const schemaSql = () => readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');

let driverPromise: Promise<Driver> | undefined;

async function makeDriver(): Promise<Driver> {
  if (env.DATABASE_URL) {
    // int8 (bigint) and numeric come back as strings by default; parse the ones we use.
    pg.types.setTypeParser(20, (v) => Number(v));
    pg.types.setTypeParser(1700, (v) => Number(v));
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 8, idleTimeoutMillis: 30_000 });
    pool.on('error', (err) => console.error('[db] pool error:', err.message));
    return {
      kind: 'neon',
      query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
      exec: async (sql) => {
        await pool.query(sql);
      },
    };
  }
  console.warn('[db] DATABASE_URL is not set. Using in-memory PGlite. Data is lost on restart.');
  const { PGlite, types } = await import('@electric-sql/pglite');
  const db = new PGlite({ parsers: { [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v) } });
  await db.exec(schemaSql());
  return {
    kind: 'pglite',
    query: async (sql, params) => (await db.query<Row>(sql, params as any[])).rows,
    exec: async (sql) => {
      await db.exec(sql);
    },
  };
}

function driver(): Promise<Driver> {
  driverPromise ??= makeDriver();
  return driverPromise;
}

export async function q<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await (await driver()).query(sql, params)) as T[];
}

export async function q1<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(sql, params))[0];
}

export async function exec(sql: string): Promise<void> {
  await (await driver()).exec(sql);
}

export async function dbKind(): Promise<'neon' | 'pglite'> {
  return (await driver()).kind;
}

/** jsonb parameter. node-pg would turn a JS array into a Postgres array otherwise. */
export const json = (v: unknown) => JSON.stringify(v ?? null);
