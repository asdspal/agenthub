// Seed the workspace through the REAL ingest path (R-005): each finding POSTs
// to the deployed /api/findings with an idem_key, so re-runs replay cleanly.
import { readFileSync } from 'node:fs';

const BASE = process.env.AGENTHUB_SEED_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const KEY = process.env.AGENTHUB_INGEST_KEY;
if (!KEY) { console.error('AGENTHUB_INGEST_KEY required'); process.exit(1); }

interface SeedFinding {
  tool: string; version: string; type: string; severity: string;
  agent_id: string; idem_key: string; title: string; body: string; link: string;
}

async function main() {
  const corpus = JSON.parse(readFileSync('data/seed/corpus.json', 'utf8')) as
    { run_key: string; findings: SeedFinding[] };
  let created = 0, replayed = 0, merged = 0, failed = 0;
  for (const f of corpus.findings) {
    const res = await fetch(`${BASE}/api/findings`, {
      method: 'POST',
      headers: { 'x-agenthub-key': KEY!, 'content-type': 'application/json' },
      body: JSON.stringify(f),
    });
    const j = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.status === 201) {
      if (j.merged_under) merged++; else created++;
      console.log(`201 ${j.merged_under ? 'MERGED' : 'NEW'}  #${j.room} ${f.title.slice(0, 50)}`);
    } else if (res.status === 200) {
      replayed++;
      console.log(`200 REPLAY #${j.room} ${f.title.slice(0, 50)}`);
    } else {
      failed++;
      console.log(`${res.status} FAIL ${f.title.slice(0, 50)}: ${JSON.stringify(j).slice(0, 120)}`);
    }
  }
  console.log(`seed: ${created} new, ${merged} merged, ${replayed} replayed, ${failed} failed`);
}
main();
