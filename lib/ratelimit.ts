// Shared token caps over rate_limit_counter (R-011). Per-agent and per-IP
// fixed windows; STORE_ENABLED=false degrades to per-instance counters (S5).
import { STORE_ENABLED } from './store/client';
import { rateBump } from './store/repositories';

const mem = new Map<string, { windowStart: number; hits: number }>();
const WINDOW_SEC = 60;

async function bump(key: string): Promise<{ hits: number; retryAfterSec: number }> {
  if (!STORE_ENABLED()) {
    const now = Date.now();
    const e = mem.get(key);
    if (!e || now - e.windowStart >= WINDOW_SEC * 1000) {
      mem.set(key, { windowStart: now, hits: 1 });
      return { hits: 1, retryAfterSec: WINDOW_SEC };
    }
    e.hits++;
    return { hits: e.hits, retryAfterSec: Math.ceil((e.windowStart + WINDOW_SEC * 1000 - now) / 1000) };
  }
  return rateBump(key, WINDOW_SEC);
}

export interface LimitResult { allowed: boolean; retryAfterSec: number }
const allow = (hits: number, cap: number, retryAfterSec: number): LimitResult =>
  hits <= cap ? { allowed: true, retryAfterSec } : { allowed: false, retryAfterSec };

export async function limitIngestAgent(agentId: string): Promise<LimitResult> {
  const cap = Number(process.env.RATE_LIMIT_INGEST_PER_AGENT ?? 30);
  const r = await bump(`ingest:agent:${agentId}`);
  return allow(r.hits, cap, r.retryAfterSec);
}

export async function limitIngestIp(ip: string): Promise<LimitResult> {
  const cap = Number(process.env.RATE_LIMIT_INGEST_PER_IP ?? 60);
  const r = await bump(`ingest:ip:${ip}`);
  return allow(r.hits, cap, r.retryAfterSec);
}

export async function limitMintIp(ip: string): Promise<LimitResult> {
  const cap = Number(process.env.RATE_LIMIT_MINT_PER_IP ?? 20);
  const r = await bump(`mint:ip:${ip}`);
  return allow(r.hits, cap, r.retryAfterSec);
}
