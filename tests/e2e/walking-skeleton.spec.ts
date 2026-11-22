// M0.4 walking skeleton against the DEPLOYED host:
//   health 200 -> POST finding 201 (message_id, room) -> title visible in
//   the tool room within 60s.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const BASE = process.env.AGENTHUB_BASE_URL ?? 'https://agenthub-sigma-nine.vercel.app';

function env(name: string): string {
  const line = readFileSync(`${process.cwd()}/.env.local`, 'utf8')
    .split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from .env.local`);
  return line.slice(name.length + 1);
}

test('M0.4 walking skeleton on deployed host', async ({ page, request }) => {
  test.setTimeout(120_000);
  const corr = `m04-${Date.now()}`;
  const title = `M0.4 hello-world ${corr}`;

  const health = await request.get(`${BASE}/api/health`);
  expect(health.status()).toBe(200);
  const h = await health.json();
  expect(h.ok).toBe(true);

  const post = await request.post(`${BASE}/api/findings`, {
    headers: {
      'x-agenthub-key': env('AGENTHUB_INGEST_KEY'),
      'content-type': 'application/json',
      'x-correlation-id': corr,
    },
    data: {
      tool: 'nexconn', version: '26.5.1', type: 'tip', severity: 'low',
      title, body: 'walking skeleton acceptance message',
      agent_id: 'agent-e2e-m04', room: 'nexconn',
    },
  });
  expect(post.status()).toBe(201);
  const body = await post.json();
  expect(body.message_id).toBeTruthy();
  expect(body.room).toBe('nexconn');
  console.log(`finding message_id=${body.message_id} room=${body.room}`);

  await page.goto(`${BASE}/workspace`);
  // The panel polls every 8s; the room button defaults to the first room.
  await page.locator('aside button', { hasText: 'nexconn' }).first().click()
    .catch(() => {});
  await expect(page.getByText(title)).toBeVisible({ timeout: 60_000 });
});
