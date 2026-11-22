// POST /api/session/token — demo token broker (srd.md §7.2, §11).
// Identity allowlist, per-IP mint cap, Problem documents, correlation id.
import { randomUUID } from 'node:crypto';
import { mintUserToken } from '@/lib/nexconn/tokens';
import { limitMintIp } from '@/lib/ratelimit';

const problem = (status: number, detail: string, extra: Record<string, unknown>, headers: HeadersInit) =>
  Response.json({ type: 'about:blank', title: detail, status, ...extra }, { status, headers });

// Allowlist: the demo supervisor identity plus agent-* identities (agents
// mint via the ingest path with the ingest key; the broker is browser-facing).
const ALLOWED = (id: string) =>
  id === (process.env.DEMO_SUPERVISOR_ID || 'supervisor-demo');

export async function POST(request: Request) {
  const corr = request.headers.get('x-correlation-id') ?? randomUUID();
  const headers = { 'X-Correlation-Id': corr };
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  const cap = await limitMintIp(ip);
  if (!cap.allowed) {
    return problem(429, 'RATE_LIMITED', { scope: 'mint' },
      { ...headers, 'Retry-After': String(cap.retryAfterSec) });
  }

  let identity: string;
  try {
    const body = await request.json();
    identity = String(body?.identity ?? '');
  } catch {
    return problem(422, 'BAD_JSON', { field: 'body' }, headers);
  }
  if (!ALLOWED(identity)) {
    return problem(422, 'IDENTITY_NOT_ALLOWED', { field: 'identity' }, headers);
  }
  try {
    const token = await mintUserToken(identity, identity);
    return Response.json({ token, user_id: identity, expires_in: 3600 }, { headers });
  } catch (e) {
    return problem(502, 'NEXCONN_UNAVAILABLE',
      { detail: String(e).slice(0, 120) }, headers);
  }
}
