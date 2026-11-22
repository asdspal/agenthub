// Idempotent migration: apply lib/store/schema.sql (the frozen stage-2 DDL).
import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';

async function main() {
  const url = process.argv[2] ?? process.env.TURSO_DATABASE_URL ?? 'file:dev.db';
  const client = createClient({
    url,
    authToken: url.startsWith('file:') ? undefined : process.env.TURSO_AUTH_TOKEN,
  });
  const sql = readFileSync('lib/store/schema.sql', 'utf8');
  await client.executeMultiple(sql);
  const shown = url.startsWith('file:') ? url : url.split('@')[1] ?? 'hosted';
  console.log(`migrate: applied schema to ${shown}`);
}
main();
