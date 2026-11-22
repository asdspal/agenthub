import { randomUUID } from 'node:crypto';
import { listRooms } from '@/lib/nexconn/client';

// Spike/test-probe rooms created before room slugs were readable tool names
// (M0.2 sdk-matrix runs, M0.3 chatui probe) — never real findings, hidden
// from the browsable list rather than relying on a Nexconn delete call.
const HIDDEN = new Set(['chatuiprobe', 'x']);
const isSpikeId = (slug: string) => /^m0[a-z0-9]{9,}$/.test(slug);
// Ad-hoc rooms created by the demo-recording's replay/conflict terminal
// (a fresh, empty room per take so that segment never collides with seeded
// content) — scratch, not real findings.
const isDemoRecordingRoom = (slug: string) => /^demo\d{9,}$/.test(slug);

export async function GET() {
  const headers = { 'X-Correlation-Id': randomUUID() };
  try {
    const rooms = (await listRooms())
      .filter((r) => !HIDDEN.has(r) && !isSpikeId(r) && !isDemoRecordingRoom(r));
    return Response.json({ rooms }, { headers });
  } catch (e) {
    return Response.json({ error: 'NEXCONN_UNAVAILABLE', detail: String(e).slice(0, 200) },
      { status: 502, headers });
  }
}
