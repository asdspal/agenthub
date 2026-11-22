// Verify: 11 tables, 2 views.
import { createClient } from '@libsql/client';

async function main() {
  const url = process.argv[2] ?? process.env.TURSO_DATABASE_URL ?? 'file:dev.db';
  const client = createClient({
    url,
    authToken: url.startsWith('file:') ? undefined : process.env.TURSO_AUTH_TOKEN,
  });
  const t = await client.execute("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const v = await client.execute("SELECT count(*) c FROM sqlite_master WHERE type='view'");
  console.log(`tables=${t.rows[0].c} views=${v.rows[0].c}`);
  if (Number(t.rows[0].c) !== 11 || Number(v.rows[0].c) !== 2) process.exit(1);
  console.log('STORE-VERIFY-OK');
}
main();
