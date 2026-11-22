// Room resolve/create (R-001): store lookup first, Nexconn subchannel/create
// second, tool_room upsert last. UNIQUE(tenant_id,slug) absorbs create races.
import { STORE_ENABLED } from '../store/client';
import { ensureTenant, getRoom, putRoom, type ToolRoom } from '../store/repositories';
import { ensureRoom } from './client';

export async function resolveRoom(slug: string, creatorId: string): Promise<ToolRoom> {
  if (STORE_ENABLED()) {
    const tenant = await ensureTenant();
    const existing = await getRoom(tenant.id, slug);
    if (existing) return existing;
    await ensureRoom(creatorId, slug); // idempotent server-side
    return putRoom(tenant.id, slug, slug);
  }
  await ensureRoom(creatorId, slug);
  return { id: -1, slug, channel_id: slug };
}
