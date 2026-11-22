import { randomUUID } from 'node:crypto';
import { probe } from '@/lib/nexconn/client';

export async function GET() {
  const deps = await probe();
  return Response.json(
    { ok: deps.nexconn, nexconn: deps.nexconn, store: deps.store },
    { status: deps.nexconn ? 200 : 503, headers: { 'X-Correlation-Id': randomUUID() } },
  );
}
