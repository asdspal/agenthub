// Tier-2 store adapter (ADR SD-2). Nexconn is the system of record; this is a
// rebuildable projection + app-owned ledger (rate limits, audit, seed runs).
import { createClient, type Client } from '@libsql/client';

let cached: Client | null = null;

export const STORE_ENABLED = () => process.env.STORE_ENABLED === 'true';

export function db(): Client {
  if (!cached) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error('TURSO_DATABASE_URL missing');
    cached = createClient({
      url,
      authToken: url.startsWith('file:') ? undefined : process.env.TURSO_AUTH_TOKEN,
    });
  }
  return cached;
}

// Test/dev hook: swap in a file: client without env juggling.
export function useClient(c: Client | null) { cached = c; }
