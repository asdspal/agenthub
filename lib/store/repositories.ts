// Parameterized, tenant-scoped queries — one helper per srd.md §4.2 query.
import type { Client } from '@libsql/client';
import { db } from './client';
import { createHash } from 'node:crypto';

export interface Tenant { id: string; app_key: string }
export interface ToolRoom { id: number; slug: string; channel_id: string }
export interface FindingRow {
  id: number; message_id: string; agent_id: string; tool: string; version: string;
  type: string; severity: string; title: string; body: string; snippet: string;
  link: string; idem_key: string | null; fingerprint: string; token_set: string;
  merged_under_message_id: string | null; posted_at: string;
}

const now = () => new Date().toISOString();

// Single-tenant resolution: one row per App Key (srd.md §7). Id is a stable
// hash of the app key so concurrent bootstraps converge on one row.
export async function ensureTenant(c: Client = db()): Promise<Tenant> {
  const appKey = process.env.NEXCONN_APP_KEY ?? 'local';
  const id = `t_${createHash('sha256').update(appKey).digest('hex').slice(0, 12)}`;
  await c.execute({
    sql: `INSERT INTO tenant (id, app_key, display_name, created_at)
          VALUES (?, ?, 'AgentHub', ?) ON CONFLICT (app_key) DO NOTHING`,
    args: [id, appKey, now()],
  });
  const r = await c.execute({ sql: 'SELECT id, app_key FROM tenant WHERE app_key = ?', args: [appKey] });
  return { id: String(r.rows[0].id), app_key: String(r.rows[0].app_key) };
}

// R-001: room resolve (idx_tool_room_tenant_slug).
export async function getRoom(tenantId: string, slug: string, c: Client = db()): Promise<ToolRoom | null> {
  const r = await c.execute({
    sql: 'SELECT id, slug, channel_id FROM tool_room WHERE tenant_id = ? AND slug = ?',
    args: [tenantId, slug],
  });
  return r.rows.length ? (r.rows[0] as unknown as ToolRoom) : null;
}

// R-001: room create (UNIQUE(tenant_id,slug) is the concurrency control).
export async function putRoom(tenantId: string, slug: string, channelId: string, c: Client = db()): Promise<ToolRoom> {
  await c.execute({
    sql: `INSERT INTO tool_room (tenant_id, slug, channel_id, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (tenant_id, slug) DO UPDATE SET channel_id = channel_id`,
    args: [tenantId, slug, channelId, now()],
  });
  return (await getRoom(tenantId, slug, c))!;
}

export async function listRoomSlugs(tenantId: string, c: Client = db()): Promise<string[]> {
  const r = await c.execute({
    sql: 'SELECT slug FROM tool_room WHERE tenant_id = ? ORDER BY slug', args: [tenantId] });
  return r.rows.map((x) => String(x.slug));
}

// R-016/R-002: agent identity upsert; agent_id is used verbatim.
export async function upsertAgent(tenantId: string, agentId: string, c: Client = db()) {
  await c.execute({
    sql: `INSERT INTO agent_identity (id, tenant_id, display_name, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    args: [agentId, tenantId, agentId, now(), now()],
  });
}

// R-002/R-007/R-009: finding projection insert.
export async function insertFinding(
  tenantId: string, roomId: number, f: Omit<FindingRow, 'id'>, c: Client = db(),
) {
  const r = await c.execute({
    sql: `INSERT INTO finding
          (tenant_id, room_id, message_id, agent_id, tool, version, type, severity,
           title, body, snippet, link, idem_key, fingerprint, token_set,
           merged_under_message_id, posted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [tenantId, roomId, f.message_id, f.agent_id, f.tool, f.version, f.type,
      f.severity, f.title, f.body, f.snippet, f.link, f.idem_key, f.fingerprint,
      f.token_set, f.merged_under_message_id, f.posted_at],
  });
  return Number(r.lastInsertRowid);
}

// R-002: replay index (idx_idem_room_key). Returns null on miss.
export async function idemLookup(roomId: number, idemKey: string, c: Client = db()) {
  const r = await c.execute({
    sql: `SELECT fingerprint, original_message_id, original_kind
          FROM idempotency_record WHERE room_id = ? AND idem_key = ?`,
    args: [roomId, idemKey],
  });
  if (!r.rows.length) return null;
  return {
    fingerprint: String(r.rows[0].fingerprint),
    original_message_id: String(r.rows[0].original_message_id),
    original_kind: String(r.rows[0].original_kind),
  };
}

export async function idemInsert(
  tenantId: string, roomId: number, idemKey: string, fingerprint: string,
  messageId: string, kind: 'top_level' | 'merged_reply', c: Client = db(),
) {
  await c.execute({
    sql: `INSERT INTO idempotency_record
          (tenant_id, room_id, idem_key, fingerprint, original_message_id,
           original_kind, first_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (room_id, idem_key) DO NOTHING`,
    args: [tenantId, roomId, idemKey, fingerprint, messageId, kind, now()],
  });
}

// R-009: bounded dedup window scan (idx_finding_room_posted), last 50 top-level.
export async function dedupWindow(roomId: number, c: Client = db()): Promise<FindingRow[]> {
  const r = await c.execute({
    sql: `SELECT id, message_id, agent_id, tool, version, type, severity, title,
                 body, snippet, link, idem_key, fingerprint, token_set,
                 merged_under_message_id, posted_at
          FROM finding
          WHERE room_id = ? AND merged_under_message_id IS NULL
          ORDER BY posted_at DESC LIMIT 50`,
    args: [roomId],
  });
  return r.rows as unknown as FindingRow[];
}

// R-009 merge-aware replay: an idem_key may live on a dedup_merge reply.
export async function mergedReplyLookup(roomId: number, idemKey: string, c: Client = db()) {
  const r = await c.execute({
    sql: `SELECT fr.message_id, fr.finding_id
          FROM finding_reply fr JOIN finding f ON f.id = fr.finding_id
          WHERE f.room_id = ? AND fr.idem_key = ?`,
    args: [roomId, idemKey],
  });
  if (!r.rows.length) return null;
  return { message_id: String(r.rows[0].message_id), finding_id: Number(r.rows[0].finding_id) };
}

// R-006: audit writer (append-only ledger + stdout line when sink=stdout).
export async function audit(
  ev: { kind: string; correlation_id: string; agent_id?: string; room_id?: number;
        message_id?: string; key?: string; op?: string; prior_value?: string },
  tenantId: string | null, c: Client | null,
) {
  if (process.env.AUDIT_LOG_SINK !== 'db-only') {
    console.log(JSON.stringify({ audit: { ...ev, ts: now() } }));
  }
  if (!c) return;
  await c.execute({
    sql: `INSERT INTO audit_event
          (tenant_id, kind, correlation_id, agent_id, room_id, message_id,
           key, op, prior_value, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [tenantId, ev.kind, ev.correlation_id, ev.agent_id ?? null,
      ev.room_id ?? null, ev.message_id ?? null, ev.key ?? null,
      ev.op ?? null, ev.prior_value ?? null, now()],
  });
}

// R-011: fixed-window counter bump (rate_limit_counter PK is the index).
// Returns {hits, retryAfter} — caller decides reject vs allow.
export async function rateBump(
  bucketKey: string, windowSec: number, c: Client = db(),
): Promise<{ hits: number; retryAfterSec: number }> {
  const winStart = new Date(Math.floor(Date.now() / (windowSec * 1000)) * windowSec * 1000);
  await c.execute({
    sql: `INSERT INTO rate_limit_counter (bucket_key, window_start, hits, updated_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT (bucket_key) DO UPDATE SET
            hits = CASE WHEN window_start = excluded.window_start THEN hits + 1 ELSE 1 END,
            window_start = excluded.window_start,
            updated_at = excluded.updated_at`,
    args: [bucketKey, winStart.toISOString(), now()],
  });
  const r = await c.execute({
    sql: 'SELECT hits, window_start FROM rate_limit_counter WHERE bucket_key = ?',
    args: [bucketKey],
  });
  const hits = Number(r.rows[0].hits);
  const retryAfterSec = Math.max(1, windowSec - Math.floor((Date.now() - winStart.getTime()) / 1000));
  return { hits, retryAfterSec };
}

// Sweep expired windows (rate_limit_sweep, srd.md §8).
export async function rateSweep(olderThanIso: string, c: Client = db()) {
  await c.execute({
    sql: 'DELETE FROM rate_limit_counter WHERE window_start < ?', args: [olderThanIso] });
}

// R-009/R-013: finding id -> row (idx_finding_message) for merge/reply targets.
export async function findingByMessageId(messageId: string, c: Client = db()) {
  const r = await c.execute({
    sql: `SELECT id, tenant_id, room_id, message_id, agent_id, tool, version,
                 title, posted_at
          FROM finding WHERE message_id = ?`,
    args: [messageId],
  });
  if (!r.rows.length) return null;
  return r.rows[0] as unknown as { id: number; tenant_id: string; room_id: number;
    message_id: string; agent_id: string; tool: string; version: string;
    title: string; posted_at: string };
}

// R-009: a dedup_merge reply persists under the root finding.
export async function insertReply(
  tenantId: string, findingId: number, r: {
    message_id: string; agent_id: string | null; reply_kind: string | null;
    body: string; mention_user_ids?: string[]; idem_key?: string | null;
  }, c: Client = db(),
) {
  await c.execute({
    sql: `INSERT INTO finding_reply
          (tenant_id, finding_id, message_id, agent_id, reply_kind, body,
           mention_user_ids, idem_key, posted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [tenantId, findingId, r.message_id, r.agent_id, r.reply_kind,
      r.body, JSON.stringify(r.mention_user_ids ?? []), r.idem_key ?? null, now()],
  });
}

// R-009: agents_hit recount = 1 + persisted dedup_merge replies (view parity).
export async function agentsHit(findingId: number, c: Client = db()): Promise<number> {
  const r = await c.execute({
    sql: `SELECT COUNT(*) c FROM finding_reply
          WHERE finding_id = ? AND reply_kind = 'dedup_merge'`,
    args: [findingId],
  });
  return 1 + Number(r.rows[0].c);
}

// Enrichment for the card renderer: status + agents_hit + merged flag per
// message_id in one round trip.
export async function cardState(roomId: number, c: Client = db()) {
  const r = await c.execute({
    sql: `SELECT f.message_id,
                 fs.status,
                 fa.agents_hit,
                 f.merged_under_message_id
          FROM finding f
          LEFT JOIN finding_status fs ON fs.finding_id = f.id
          LEFT JOIN finding_agents_hit fa ON fa.finding_id = f.id
          WHERE f.room_id = ?
          ORDER BY f.posted_at DESC LIMIT 50`,
    args: [roomId],
  });
  const m = new Map<string, { status: string; agents_hit: number; merged_under: string | null }>();
  for (const row of r.rows) {
    m.set(String(row.message_id), {
      status: String(row.status ?? 'open'),
      agents_hit: Number(row.agents_hit ?? 1),
      merged_under: (row.merged_under_message_id as string) ?? null,
    });
  }
  return m;
}

// Replies for the thread view: grouped by root message id.
export async function repliesForRoom(roomId: number, c: Client = db()) {
  const r = await c.execute({
    sql: `SELECT fr.message_id, fr.body, fr.agent_id, fr.reply_kind, fr.posted_at,
                 f.message_id AS root_message_id
          FROM finding_reply fr JOIN finding f ON f.id = fr.finding_id
          WHERE f.room_id = ?
          ORDER BY fr.posted_at ASC`,
    args: [roomId],
  });
  return r.rows as unknown as Array<{
    message_id: string; body: string; agent_id: string | null;
    reply_kind: string | null; posted_at: string; root_message_id: string;
  }>;
}

// R-008: current votes for a finding (metadata merge needs the prior value).
export async function votesFor(findingId: number, c: Client = db()) {
  const r = await c.execute({
    sql: 'SELECT key, value FROM finding_status_vote WHERE finding_id = ?',
    args: [findingId],
  });
  return r.rows.map((x) => ({ key: String(x.key), value: String(x.value) }));
}

export async function voteAdd(
  tenantId: string, findingId: number, key: string, value: string,
  actorId: string | null, c: Client = db(),
) {
  await c.execute({
    sql: `INSERT INTO finding_status_vote (tenant_id, finding_id, key, value, actor_id, applied_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (finding_id, key, value) DO NOTHING`,
    args: [tenantId, findingId, key, value, actorId, now()],
  });
}

export async function voteRemove(findingId: number, key: string, value: string, c: Client = db()) {
  await c.execute({
    sql: 'DELETE FROM finding_status_vote WHERE finding_id = ? AND key = ? AND value = ?',
    args: [findingId, key, value],
  });
}

// Status for one card via the single-precedence view.
export async function statusFor(findingId: number, c: Client = db()): Promise<string> {
  const r = await c.execute({
    sql: 'SELECT status FROM finding_status WHERE finding_id = ?', args: [findingId] });
  return r.rows.length ? String(r.rows[0].status) : 'open';
}

// Room slug for a finding row (needed by the metadata write path).
export async function roomSlugFor(roomId: number, c: Client = db()): Promise<string | null> {
  const r = await c.execute({
    sql: 'SELECT slug FROM tool_room WHERE id = ?', args: [roomId] });
  return r.rows.length ? String(r.rows[0].slug) : null;
}
