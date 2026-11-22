// Server-side Nexconn adapter. The ONLY module that talks to the platform:
// init, Server-API token minting, connect, room resolve/create, send,
// history query, metadata read/write. Connection per request, token per
// connect (documented model — no pooling).
import './shims';
import { createHash, randomUUID } from 'node:crypto';
import { FINDING_MESSAGE_TYPE, type FindingPayload, type MessageMetadata } from './messages';

const APP_KEY = () => process.env.NEXCONN_APP_KEY ?? '';
const APP_SECRET = () => process.env.NEXCONN_API_SECRET ?? '';
const BASE_URL = () => process.env.NEXCONN_API_BASE || 'https://api.sg-light-api.com';
const COMMUNITY_ID = () => process.env.NEXCONN_COMMUNITY_ID || 'agenthub';

type NC = typeof import('@nexconn/chat');
let ncp: Promise<NC> | null = null;
async function sdk(): Promise<NC> {
  if (!ncp) {
    ncp = import('@nexconn/chat').then((m) => {
      m.NCEngine.initialize({ appKey: APP_KEY(), logLevel: m.LogLevel.WARN });
      m.NCEngine.registerCustomMessages([
        { messageType: FINDING_MESSAGE_TYPE, isPersisted: true, isCounted: true },
      ]);
      return m;
    });
  }
  return ncp;
}

function signedHeaders() {
  const nonce = String(Math.floor(Math.random() * 1e6));
  const timestamp = String(Date.now());
  const signature = createHash('sha1')
    .update(APP_SECRET() + nonce + timestamp).digest('hex');
  return {
    'App-Key': APP_KEY(), Nonce: nonce, Timestamp: timestamp,
    Signature: signature, 'X-Request-ID': randomUUID(),
    'Content-Type': 'application/json',
  };
}

async function serverApi<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL()}${path}`, {
    method: 'POST', headers: signedHeaders(), body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

const codeOk = (r: { code?: number }) => r.code === 0;

export async function mintToken(userId: string, name?: string): Promise<string> {
  const r = await serverApi<{ code: number; result?: { accessToken?: string } }>(
    '/v4/auth/access-token/issue', { userId, name: name ?? userId });
  const token = r.result?.accessToken;
  if (!codeOk(r) || !token) throw new Error(`token issue failed: code=${r.code}`);
  return token;
}

export async function ensureCommunity(userId: string) {
  await serverApi('/v4/community-channel/create',
    { userId, channelId: COMMUNITY_ID(), name: 'AgentHub' });
  await serverApi('/v4/community-channel/join', { userId, channelId: COMMUNITY_ID() });
}

export async function ensureRoom(userId: string, slug: string) {
  await serverApi('/v4/community-channel/subchannel/create',
    { channelId: COMMUNITY_ID(), subchannelId: slug, channelVisibility: 0 });
}

// One-shot ingest: mint -> connect -> resolve room -> send -> disconnect.
export async function postFinding(
  agentId: string, roomSlug: string, payload: FindingPayload,
  metadata?: MessageMetadata,
): Promise<{ messageId: string; room: string }> {
  const m = await sdk();
  const token = await mintToken(agentId, agentId);
  const conn = await m.NCEngine.connect({ token });
  if (!conn.isOk) throw new Error(`connect failed: code=${conn.code}`);
  try {
    await ensureCommunity(agentId);
    await ensureRoom(agentId, roomSlug);
    const sub = new m.CommunitySubChannel(COMMUNITY_ID(), roomSlug);
    const params = new m.SendMessageParams(payload as Record<string, unknown>, FINDING_MESSAGE_TYPE);
    if (metadata) params.metadata = metadata as Record<string, string>;
    const sent = await sub.sendMessage(params);
    if (!sent.isOk || !sent.data) throw new Error(`sendMessage failed: code=${sent.code}`);
    return { messageId: sent.data.messageId, room: roomSlug };
  } finally {
    await m.NCEngine.disconnect().catch(() => {});
  }
}

// Server-API resolve — the client getSubChannels needs a post-connect
// community sync (code 35011) that a request-scoped backend can't rely on.
export async function listRooms(): Promise<string[]> {
  const r = await serverApi<{ code: number; result?: { subchannels?: Array<{ subchannelId: string }> } }>(
    '/v4/community-channel/subchannel/list', { channelId: COMMUNITY_ID() });
  return (r.result?.subchannels ?? []).map((s) => s.subchannelId);
}

export async function recentMessages(userId: string, roomSlug: string, pageSize = 50) {
  const m = await sdk();
  await ensureCommunity(userId); // readers must be members or history is empty
  const token = await mintToken(userId, userId);
  const conn = await m.NCEngine.connect({ token });
  if (!conn.isOk) throw new Error(`connect failed: code=${conn.code}`);
  try {
    const query = m.BaseChannel.createMessagesQuery({
      channelIdentifier: new m.CommunitySubChannelIdentifier(COMMUNITY_ID(), roomSlug),
      pageSize, isAscending: false,
    });
    const page = await query.loadNextPage();
    if (!page.isOk) return [];
    const raw = page.data as unknown as { data?: unknown[] } | unknown[];
    const msgs = ((Array.isArray(raw) ? raw : raw?.data) ?? []) as Array<{
      messageId: string; messageType: string; sentTime: number; senderUserId: string;
      content: Record<string, unknown>; metadata: Map<string, string> | Record<string, string>;
    }>;
    return msgs.map((msg) => ({
      messageId: msg.messageId, messageType: msg.messageType, sentTime: msg.sentTime,
      senderUserId: msg.senderUserId, content: msg.content,
      metadata: msg.metadata instanceof Map ? Object.fromEntries(msg.metadata) : (msg.metadata ?? {}),
    }));
  } finally {
    await m.NCEngine.disconnect().catch(() => {});
  }
}

export async function setMessageMetadata(
  userId: string, roomSlug: string, messageId: string, patch: Record<string, string>,
) {
  const m = await sdk();
  await ensureCommunity(userId);
  const token = await mintToken(userId, userId);
  const conn = await m.NCEngine.connect({ token });
  if (!conn.isOk) throw new Error(`connect failed: code=${conn.code}`);
  try {
    const query = m.BaseChannel.createMessagesQuery({
      channelIdentifier: new m.CommunitySubChannelIdentifier(COMMUNITY_ID(), roomSlug),
      pageSize: 50, isAscending: false,
    });
    const page = await query.loadNextPage();
    if (!page.isOk) throw new Error(`history query failed: code=${page.code}`);
    const raw = page.data as unknown as { data?: unknown[] } | unknown[];
    const msgs = ((Array.isArray(raw) ? raw : raw?.data) ?? []) as Array<{
      messageId: string; setMetadata: (md: Record<string, string>) => Promise<{ isOk: boolean }>;
    }>;
    const target = msgs.find((x) => x.messageId === messageId);
    if (!target) throw new Error(`message ${messageId} not found in room history`);
    const r = await target.setMetadata(patch);
    if (!r.isOk) throw new Error('setMetadata failed');
  } finally {
    await m.NCEngine.disconnect().catch(() => {});
  }
}

// One connected session for batch work (rebuild, seed). Reconnecting after a
// disconnect on the same NCEngine can hang — batch through a single session.
export async function withSession<T>(
  userId: string, fn: (m: NC) => Promise<T>,
): Promise<T> {
  const m = await sdk();
  await ensureCommunity(userId);
  const token = await mintToken(userId, userId);
  const conn = await m.NCEngine.connect({ token });
  if (!conn.isOk) throw new Error(`connect failed: code=${conn.code}`);
  try {
    return await fn(m);
  } finally {
    await m.NCEngine.disconnect().catch(() => {});
  }
}

export async function probe(): Promise<{ nexconn: boolean; store: boolean }> {
  let nexconn = false;
  try {
    const t = await mintToken('agenthub-health-probe', 'health');
    nexconn = !!t;
  } catch { nexconn = false; }
  return { nexconn, store: process.env.STORE_ENABLED === 'true' };
}
