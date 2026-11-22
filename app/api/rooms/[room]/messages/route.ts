import { randomUUID } from 'node:crypto';
import { recentMessages } from '@/lib/nexconn/client';
import { FINDING_MESSAGE_TYPE } from '@/lib/nexconn/messages';
import { STORE_ENABLED } from '@/lib/store/client';
import { getRoom, ensureTenant, cardState, repliesForRoom } from '@/lib/store/repositories';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ room: string }> },
) {
  const headers = { 'X-Correlation-Id': randomUUID() };
  const { room } = await params;
  const userId = process.env.DEMO_SUPERVISOR_ID ?? 'supervisor-demo';
  try {
    const msgs = await recentMessages(userId, room, 50);

    // Store enrichment: agents_hit, status chip, reply threading (best-effort —
    // the Nexconn payload is always authoritative for card content).
    let state = new Map<string, { status: string; agents_hit: number; merged_under: string | null }>();
    const storeReplies = new Map<string, Array<{ body: string; agent_id: string | null; reply_kind: string | null }>>();
    if (STORE_ENABLED()) {
      try {
        const tenant = await ensureTenant();
        const roomRow = await getRoom(tenant.id, room);
        if (roomRow) {
          state = await cardState(roomRow.id);
          for (const r of await repliesForRoom(roomRow.id)) {
            const arr = storeReplies.get(r.root_message_id) ?? [];
            arr.push({ body: r.body, agent_id: r.agent_id, reply_kind: r.reply_kind });
            storeReplies.set(r.root_message_id, arr);
          }
        }
      } catch { /* store enrichment is optional */ }
    }

    const findings = msgs
      .filter((m) => m.messageType === FINDING_MESSAGE_TYPE)
      .filter((m) => !(m.content as Record<string, unknown>).reply_kind)
      .map((m) => {
        const md = state.get(m.messageId);
        // Merge replies sent as messages with finding_root metadata (live view
        // even before the projection row exists).
        const live = msgs.filter((r) =>
          (r.content as Record<string, unknown>).reply_kind === 'dedup_merge' &&
          (r.metadata?.finding_root === m.messageId)).length;
        return {
          messageId: m.messageId,
          sentTime: m.sentTime,
          sender: m.senderUserId,
          status: md?.status ?? 'open',
          agents_hit: md?.agents_hit ?? Math.max(1, live + 1),
          merged_under: md?.merged_under ?? null,
          replies: storeReplies.get(m.messageId) ?? [],
          ...(m.content as Record<string, unknown>),
        };
      });
    return Response.json({ room, findings }, { headers });
  } catch (e) {
    return Response.json({ error: 'NEXCONN_UNAVAILABLE', detail: String(e).slice(0, 200) },
      { status: 502, headers });
  }
}
