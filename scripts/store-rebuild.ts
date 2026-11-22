// Rebuild projections from Nexconn history (SD-2 recovery, srd.md §4.5):
// 1) ensure tenant  2) resync rooms from subchannel list  3) replay each
// room's history into finding/finding_reply/idempotency_record (INSERT OR
// IGNORE — never overwrites durable rows)  4) report counts.
//
// Top-level findings and dedup_merge/escalation replies are both sent as
// `agenthub_finding` messages; a reply (content.reply_kind set) must land in
// finding_reply, never in `finding` — inserting it there too would create a
// phantom top-level row that pollutes the dedup window on the next ingest.
import { createClient } from '@libsql/client';
import { tokenize, tokenSetString } from '../lib/dedup/tokens';
import { createHash, randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

async function main() {
  const url = process.env.TURSO_DATABASE_URL ?? 'file:dev.db';
  const c = createClient({
    url, authToken: url.startsWith('file:') ? undefined : process.env.TURSO_AUTH_TOKEN,
  });
  const appKey = process.env.NEXCONN_APP_KEY ?? 'local';
  const tid = `t_${createHash('sha256').update(appKey).digest('hex').slice(0, 12)}`;
  await c.execute({
    sql: `INSERT INTO tenant (id, app_key, display_name, created_at)
          VALUES (?, ?, 'AgentHub', ?) ON CONFLICT (app_key) DO NOTHING`,
    args: [tid, appKey, now()],
  });

  // Rooms: union of store rows and Nexconn list. One session for all rooms —
  // reconnecting a disconnected NCEngine in the same process can hang.
  const { listRooms, withSession } = await import('../lib/nexconn/client');
  const ncRooms = await listRooms();
  const storeRooms = (await c.execute({
    sql: 'SELECT slug FROM tool_room WHERE tenant_id = ?', args: [tid] }))
    .rows.map((r) => String(r.slug));
  const all = [...new Set([...ncRooms, ...storeRooms])];
  for (const slug of all) {
    await c.execute({
      sql: `INSERT INTO tool_room (tenant_id, slug, channel_id, created_at)
            VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, slug) DO NOTHING`,
      args: [tid, slug, slug, now()],
    });
  }

  const roomMsgs = await withSession('agenthub-rebuild', async (m) => {
    const out = new Map<string, Array<Record<string, unknown>>>();
    for (const slug of all) {
      const q = m.BaseChannel.createMessagesQuery({
        channelIdentifier: new m.CommunitySubChannelIdentifier('agenthub', slug),
        pageSize: 50, isAscending: false,
      });
      const page = await q.loadNextPage().catch(() => null);
      const raw = page?.data as unknown as { data?: unknown[] } | unknown[] | undefined;
      const msgs = ((Array.isArray(raw) ? raw : raw?.data) ?? []) as Array<Record<string, unknown>>;
      out.set(slug, msgs.map((mm) => {
        const md = mm.metadata as Map<string, string> | Record<string, string> | undefined;
        return {
          messageId: mm.messageId, messageType: mm.messageType,
          sentTime: mm.sentTime, senderUserId: mm.senderUserId,
          content: mm.content,
          metadata: md instanceof Map ? Object.fromEntries(md) : (md ?? {}),
        };
      }));
    }
    return out;
  });

  let findings = 0;
  let replies = 0;
  // Second pass for replies: finding rows must exist first to resolve finding_id.
  const pendingReplies: Array<{ slug: string; m: { messageId: string; sentTime: number;
    senderUserId: string; content: Record<string, unknown>; metadata: Record<string, string> } }> = [];

  for (const slug of all) {
    const room = (await c.execute({
      sql: 'SELECT id FROM tool_room WHERE tenant_id = ? AND slug = ?', args: [tid, slug] }))
      .rows[0];
    const msgs = (roomMsgs.get(slug) ?? []) as Array<{
      messageId: string; messageType: string; sentTime: number;
      senderUserId: string; content: Record<string, unknown>; metadata: Record<string, string>;
    }>;
    for (const m of msgs) {
      if (m.messageType !== 'agenthub_finding') continue;
      const p = m.content as Record<string, unknown>;
      if (p.reply_kind) { pendingReplies.push({ slug, m }); continue; } // reply, not a root
      const agentId = String(p.agent_id ?? m.senderUserId ?? 'unknown');
      if (!/^agent-[a-z0-9][a-z0-9-]*$/.test(agentId)) continue;
      await c.execute({
        sql: `INSERT INTO agent_identity (id, tenant_id, display_name, created_at)
              VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        args: [agentId, tid, agentId, now()],
      });
      const r = await c.execute({
        sql: `INSERT OR IGNORE INTO finding
              (tenant_id, room_id, message_id, agent_id, tool, version, type,
               severity, title, body, snippet, link, idem_key, fingerprint,
               token_set, merged_under_message_id, posted_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        args: [tid, room.id, m.messageId, agentId,
          String(p.tool ?? ''), String(p.version ?? ''), String(p.type ?? 'tip'),
          String(p.severity ?? 'medium'), String(p.title ?? ''),
          String(p.body ?? ''), String(p.snippet ?? ''), String(p.link ?? ''),
          (p.idem_key as string) ?? null,
          createHash('sha256').update(String(m.messageId)).digest('hex'),
          tokenSetString(tokenize(String(p.title ?? ''), String(p.body ?? ''),
            String(p.tool ?? ''), String(p.version ?? ''))),
          new Date(Number(m.sentTime) || Date.now()).toISOString()],
      });
      if (r.rowsAffected) findings++;
      if (p.idem_key) {
        await c.execute({
          sql: `INSERT OR IGNORE INTO idempotency_record
                (tenant_id, room_id, idem_key, fingerprint, original_message_id,
                 original_kind, first_seen_at)
                VALUES (?, ?, ?, '', ?, 'top_level', ?)`,
          args: [tid, room.id, String(p.idem_key), m.messageId, now()],
        });
      }
    }
    console.log(`  ${slug}: ${msgs.filter((m) => m.messageType === 'agenthub_finding' && !(m.content as Record<string, unknown>).reply_kind).length} findings in history`);
  }

  for (const { m } of pendingReplies) {
    const p = m.content as Record<string, unknown>;
    const rootId = m.metadata?.finding_root;
    if (!rootId) continue;
    const root = (await c.execute({
      sql: 'SELECT id, room_id FROM finding WHERE message_id = ?', args: [rootId] })).rows[0];
    if (!root) continue; // root not projected (yet, or pruned) — skip rather than orphan
    const agentId = String(p.agent_id ?? m.senderUserId ?? '');
    const r = await c.execute({
      sql: `INSERT OR IGNORE INTO finding_reply
            (tenant_id, finding_id, message_id, agent_id, reply_kind, body,
             mention_user_ids, idem_key, posted_at)
            VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      args: [tid, root.id, m.messageId, agentId || null, String(p.reply_kind),
        String(p.title ?? p.body ?? ''), (p.idem_key as string) ?? null,
        new Date(Number(m.sentTime) || Date.now()).toISOString()],
    });
    if (r.rowsAffected) replies++;
    if (p.idem_key) {
      await c.execute({
        sql: `INSERT OR IGNORE INTO idempotency_record
              (tenant_id, room_id, idem_key, fingerprint, original_message_id,
               original_kind, first_seen_at)
              VALUES (?, ?, ?, '', ?, 'merged_reply', ?)`,
        args: [tid, root.room_id, String(p.idem_key), m.messageId, now()],
      });
    }
  }

  console.log(`rebuild: ${all.length} rooms synced, ${findings} findings + ${replies} replies projected (run_key=${randomUUID().slice(0, 8)})`);
  console.log('STORE-REBUILD-OK');
}
main();
