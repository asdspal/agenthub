// POST /api/findings — W1 ingestion (srd.md §5.2):
//   auth -> per-IP cap -> validate -> per-agent cap -> resolve room ->
//   replay check -> send as agent_id -> project rows -> audit -> 201.
import { randomUUID } from 'node:crypto';
import { postFinding } from '@/lib/nexconn/client';
import { resolveRoom } from '@/lib/nexconn/rooms';
import { findingSchema, roomSlug } from '@/lib/validation/finding';
import { fingerprint } from '@/lib/fingerprint';
import { tokenize, tokenSetString } from '@/lib/dedup/tokens';
import { db, STORE_ENABLED } from '@/lib/store/client';
import {
  ensureTenant, upsertAgent, insertFinding, idemLookup, idemInsert, audit,
  dedupWindow, insertReply, agentsHit,
} from '@/lib/store/repositories';
import { bestMatch } from '@/lib/dedup/score';
import { limitIngestAgent, limitIngestIp } from '@/lib/ratelimit';
import type { FindingPayload } from '@/lib/nexconn/messages';

const problem = (status: number, detail: string, extra: Record<string, unknown>, headers: HeadersInit) =>
  Response.json({ type: 'about:blank', title: detail, status, ...extra }, { status, headers });

export async function POST(request: Request) {
  const corr = request.headers.get('x-correlation-id') ?? randomUUID();
  const headers = { 'X-Correlation-Id': corr };
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

  if (request.headers.get('x-agenthub-key') !== process.env.AGENTHUB_INGEST_KEY) {
    return problem(401, 'AUTH_REQUIRED', {}, headers);
  }

  const ipCap = await limitIngestIp(ip);
  if (!ipCap.allowed) {
    return problem(429, 'RATE_LIMITED', { scope: 'ip' },
      { ...headers, 'Retry-After': String(ipCap.retryAfterSec) });
  }

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return problem(422, 'BAD_JSON', { field: 'body' }, headers);
  }
  const parsed = findingSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    await audit({ kind: 'ingest', correlation_id: corr, op: 'rejected',
      prior_value: issue?.message }, null, STORE_ENABLED() ? db() : null)
      .catch(() => {});
    return problem(422, 'VALIDATION', {
      field: issue?.path.join('.') ?? 'unknown', detail: issue?.message,
    }, headers);
  }
  const f = parsed.data;

  const agentCap = await limitIngestAgent(f.agent_id);
  if (!agentCap.allowed) {
    return problem(429, 'RATE_LIMITED', { scope: 'agent' },
      { ...headers, 'Retry-After': String(agentCap.retryAfterSec) });
  }

  const slug = roomSlug(String(f.room ?? f.tool));
  const store = STORE_ENABLED() ? db() : null;
  let tenantId: string | null = null;
  let roomId = -1;

  // Resolve room (R-001): store row first, Nexconn subchannel/create fallback.
  const room = await resolveRoom(slug, f.agent_id);
  roomId = room.id;

  // Replay check (R-002): per-room idem scope, fingerprint decides 200 vs 409.
  const fp = fingerprint(f);
  if (f.idem_key && store) {
    if (!tenantId) tenantId = (await ensureTenant(store)).id;
    const prior = await idemLookup(roomId, f.idem_key, store);
    if (prior) {
      await audit({ kind: 'replay', correlation_id: corr, agent_id: f.agent_id,
        room_id: roomId, message_id: prior.original_message_id }, tenantId, store);
      if (prior.fingerprint === fp) {
        return Response.json({
          message_id: prior.original_message_id, room: slug,
          replayed: true, merged_under: null, agents_hit: 1,
        }, { status: 200, headers });
      }
      return problem(409, 'IDEMPOTENCY_CONFLICT',
        { original_message_id: prior.original_message_id }, headers);
    }
  }

  // Dedup merge (R-009): score the room's top-level window; on a match, send
  // a reply_kind='dedup_merge' reply under the root instead of a new finding.
  if (store) {
    if (!tenantId) tenantId = (await ensureTenant(store)).id;
    const match = bestMatch(f, await dedupWindow(roomId, store));
    if (match) {
      const mergePayload: FindingPayload = {
        tool: f.tool, version: f.version, type: f.type, severity: f.severity,
        title: f.title, body: f.body, snippet: f.snippet, link: f.link,
        reply_kind: 'dedup_merge', idem_key: f.idem_key,
      };
      const sent = await postFinding(f.agent_id, slug, mergePayload,
        { finding_root: match.row.message_id });
      await upsertAgent(tenantId, f.agent_id, store);
      await insertReply(tenantId, match.row.id, {
        message_id: sent.messageId, agent_id: f.agent_id,
        reply_kind: 'dedup_merge', body: f.title,
        idem_key: f.idem_key ?? null,
      }, store);
      if (f.idem_key) {
        await idemInsert(tenantId, roomId, f.idem_key, fp, sent.messageId, 'merged_reply', store);
      }
      const hit = await agentsHit(match.row.id, store);
      await audit({ kind: 'merge_repair', correlation_id: corr, agent_id: f.agent_id,
        room_id: roomId, message_id: match.row.message_id,
        op: `agents_hit=${hit}`, prior_value: String(match.score.toFixed(3)) },
        tenantId, store);
      return Response.json({
        message_id: sent.messageId, room: slug,
        merged_under: match.row.message_id, agents_hit: hit,
      }, { status: 201, headers });
    }
  }

  // Send as the agent identity (R-007). One retry with 2s backoff on failure.
  const payload: FindingPayload = {
    tool: f.tool, version: f.version, type: f.type, severity: f.severity,
    title: f.title, body: f.body, snippet: f.snippet, link: f.link,
    idem_key: f.idem_key,
  };
  let messageId: string;
  try {
    messageId = (await postFinding(f.agent_id, slug, payload)).messageId;
  } catch (e1) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      messageId = (await postFinding(f.agent_id, slug, payload)).messageId;
    } catch (e2) {
      return problem(502, 'NEXCONN_UNAVAILABLE',
        { detail: String(e2).slice(0, 200), first: String(e1).slice(0, 100) }, headers);
    }
  }

  // Projection only after a successful send — no orphan rows (W1).
  if (store) {
    try {
      if (!tenantId) tenantId = (await ensureTenant(store)).id;
      await upsertAgent(tenantId, f.agent_id, store);
      const fid = await insertFinding(tenantId, roomId, {
        message_id: messageId, agent_id: f.agent_id, tool: f.tool,
        version: f.version, type: f.type, severity: f.severity,
        title: f.title, body: f.body, snippet: f.snippet, link: f.link,
        idem_key: f.idem_key ?? null, fingerprint: fp,
        token_set: tokenSetString(tokenize(f.title, f.body, f.tool, f.version)),
        merged_under_message_id: null,
        posted_at: new Date().toISOString(),
      }, store);
      if (f.idem_key) await idemInsert(tenantId, roomId, f.idem_key, fp, messageId, 'top_level', store);
      await audit({ kind: 'ingest', correlation_id: corr, agent_id: f.agent_id,
        room_id: roomId, message_id: messageId, op: `finding:${fid}` }, tenantId, store);
    } catch (e) {
      // Send succeeded but projection failed — 503; store-rebuild recovers it.
      return problem(503, 'PROJECTION_FAILED',
        { detail: String(e).slice(0, 200), message_id: messageId }, headers);
    }
  } else {
    await audit({ kind: 'ingest', correlation_id: corr, agent_id: f.agent_id,
      message_id: messageId }, null, null);
  }

  return Response.json(
    { message_id: messageId, room: slug, merged_under: null, agents_hit: 1 },
    { status: 201, headers });
}
