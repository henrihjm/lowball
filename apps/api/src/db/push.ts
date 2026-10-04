// pnpm db:push  applies schema.sql to the database in DATABASE_URL.
import { env } from '../env.js';
import { exec, q, schemaSql } from './client.js';

if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put the Neon connection string in .env first.');
  process.exit(1);
}
await exec(schemaSql());
const tables = await q<{ table_name: string }>(
  "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
);
console.log('Schema applied. Tables:', tables.map((t) => t.table_name).join(', '));
process.exit(0);
