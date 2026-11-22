// POST /api/findings/{id}/react — W3 status metadata write (R-008).
// Read-merge-write of one key on the Nexconn message (source of truth) plus
// the finding_status_vote projection. Demo scope: browser supervisor reacts
// without the ingest key (documented R-008 limitation — agent-grade authz is
// post-demo work); the ingest key also works for scripted reacts.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, STORE_ENABLED } from '@/lib/store/client';
import {
  findingByMessageId, roomSlugFor, votesFor, voteAdd, voteRemove,
  statusFor, audit,
} from '@/lib/store/repositories';
import { setMessageMetadata } from '@/lib/nexconn/client';

const bodySchema = z.object({
  key: z.enum(['confirmed_by', 'refuted_by', 'fixed_in', 'duplicate_of']),
  value: z.string().min(1).max(128),
  op: z.enum(['add', 'remove']).default('add'),
  actor_id: z.string().max(64).optional(),
}).strict();

const LIST_KEYS = new Set(['confirmed_by', 'refuted_by']);
const problem = (status: number, detail: string, extra: Record<string, unknown>, headers: HeadersInit) =>
  Response.json({ type: 'about:blank', title: detail, status, ...extra }, { status, headers });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const corr = request.headers.get('x-correlation-id') ?? randomUUID();
  const headers = { 'X-Correlation-Id': corr };
  const { id } = await params;

  if (!STORE_ENABLED()) return problem(503, 'STORE_DISABLED', {}, headers);

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return problem(422, 'BAD_JSON', { field: 'body' }, headers);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return problem(422, 'VALIDATION',
      { field: issue?.path.join('.') ?? 'unknown', detail: issue?.message }, headers);
  }
  const { key, value, op } = parsed.data;
  const actor = parsed.data.actor_id ?? process.env.DEMO_SUPERVISOR_ID ?? 'supervisor-demo';
  const store = db();

  const finding = await findingByMessageId(id, store);
  if (!finding) return problem(404, 'FINDING_NOT_FOUND', { message_id: id }, headers);
  const slug = await roomSlugFor(finding.room_id, store);
  if (!slug) return problem(404, 'ROOM_NOT_FOUND', {}, headers);

  // Merge: list keys accumulate unique values; scalar keys last-write-wins.
  const prior = (await votesFor(finding.id, store))
    .filter((v) => v.key === key).map((v) => v.value);
  let merged: string;
  if (LIST_KEYS.has(key)) {
    const set = new Set(prior);
    if (op === 'add') set.add(value); else set.delete(value);
    merged = [...set].sort().join(',');
    if (op === 'add') await voteAdd(finding.tenant_id, finding.id, key, value, actor, store);
    else await voteRemove(finding.id, key, value, store);
  } else {
    merged = op === 'add' ? value : '';
    for (const p of prior) await voteRemove(finding.id, key, p, store);
    if (op === 'add') await voteAdd(finding.tenant_id, finding.id, key, value, actor, store);
  }

  // Write through to Nexconn metadata (source of truth).
  try {
    await setMessageMetadata(actor, slug, id, { [key]: merged });
  } catch (e) {
    return problem(502, 'NEXCONN_UNAVAILABLE', { detail: String(e).slice(0, 160) }, headers);
  }

  const status = await statusFor(finding.id, store);
  await audit({ kind: 'metadata_write', correlation_id: corr, agent_id: actor,
    room_id: finding.room_id, message_id: id, key, op,
    prior_value: prior.join(',') }, finding.tenant_id, store);

  return Response.json({ message_id: id, key, value: merged, status }, { headers });
}
