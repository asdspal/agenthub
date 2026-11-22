'use client';
// Findings panel: the finding cards render here as application-built
// diagnostics (ChatUI does not render the agenthub_finding custom message
// type — the SDK still carries every byte), fed by
// /api/rooms/[room]/messages.
import { useCallback, useEffect, useState } from 'react';
import { filterFindings, filterRooms } from '@/lib/search';

interface Finding {
  messageId: string;
  sentTime: number;
  sender: string;
  status?: string;
  agents_hit?: number;
  replies?: Array<{ body: string; agent_id: string | null; reply_kind: string | null }>;
  tool?: string;
  version?: string;
  type?: string;
  severity?: string;
  title?: string;
  body?: string;
  snippet?: string;
  link?: string;
}

// Severity reads as a leading dot (reusing the connection-status dot motif
// from the top bar), not a side rule — a one-sided accent bar is a default
// to refuse, not a choice made for this content.
const SEV_DOT: Record<string, string> = {
  critical: 'bg-critical', high: 'bg-signal',
  medium: 'bg-foreground-muted', low: 'bg-line',
};
const STATUS_LABEL: Record<string, string> = {
  open: 'text-foreground-muted', confirmed: 'text-merge', refuted: 'text-critical',
  disputed: 'text-signal', fixed: 'text-[#8fb8d6]', duplicate: 'text-[#b39bdb]',
};

export default function FindingsPanel() {
  const [rooms, setRooms] = useState<string[]>([]);
  const [room, setRoom] = useState<string>('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [status, setStatus] = useState('loading');
  const [roomQuery, setRoomQuery] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    const loadRooms = async () => {
      try {
        const r = await fetch('/api/rooms');
        const j = await r.json();
        if (!live) return;
        const list: string[] = j.rooms ?? [];
        setRooms(list);
        setRoom((cur) => cur || (list.includes('nexconn') ? 'nexconn' : list[0]) || '');
        setStatus(list.length ? 'ok' : 'no-rooms');
      } catch { if (live) setStatus('rooms-error'); }
    };
    const t0 = setTimeout(loadRooms, 0);
    const t = setInterval(loadRooms, 15000);
    return () => { live = false; clearTimeout(t0); clearInterval(t); };
  }, []);

  const loadFindings = useCallback(async (slug: string) => {
    if (!slug) return;
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(slug)}/messages`);
      const j = await r.json();
      if (Array.isArray(j.findings)) setFindings(j.findings);
    } catch { /* keep last-known list */ }
  }, []);

  useEffect(() => {
    if (!room) return;
    (window as unknown as { __agenthubRoom?: string }).__agenthubRoom = room;
    window.dispatchEvent(new CustomEvent('agenthub:room', { detail: room }));
    const t0 = setTimeout(() => loadFindings(room), 0);
    const t = setInterval(() => loadFindings(room), 8000);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, [room, loadFindings]);

  const visibleRooms = filterRooms(rooms, roomQuery);
  const visibleFindings = filterFindings(findings, query);

  return (
    <div className="flex h-full bg-background text-foreground">
      <aside className="w-44 shrink-0 border-r border-line p-3 overflow-y-auto">
        <div className="mb-2 flex items-center justify-between text-[11px] text-foreground-muted">
          <span>rooms</span>
          <span>{status === 'ok' ? rooms.length : status}</span>
        </div>
        <input
          aria-label="Filter rooms"
          value={roomQuery}
          onChange={(e) => setRoomQuery(e.target.value)}
          placeholder="filter"
          className="mb-2 w-full border-b border-line bg-transparent px-1 py-1 text-xs text-foreground placeholder-foreground-muted outline-none focus:border-signal"
        />
        {visibleRooms.map((r) => (
          <button key={r} onClick={() => { setRoom(r); setFindings([]); }}
            className={`block w-full truncate px-1 py-1 text-left text-sm
              ${r === room ? 'text-signal' : 'text-foreground-muted hover:text-foreground'}`}>
            {r}
          </button>
        ))}
        {visibleRooms.length === 0 && (
          <div className="px-1 py-1 text-xs text-foreground-muted">
            {roomQuery ? `nothing matches "${roomQuery}"` : 'no rooms yet'}
          </div>
        )}
      </aside>
      <main className="flex-1 overflow-y-auto p-5">
        {room && (
          <div className="mb-4 flex items-baseline gap-3 border-b border-line pb-3">
            <h2 className="text-xl font-medium text-foreground">{room}</h2>
            <span className="text-xs text-foreground-muted">
              {visibleFindings.length}/{findings.length}
            </span>
            <input
              aria-label="Search findings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search title, body, tool, version"
              className="ml-auto w-64 border-b border-line bg-transparent px-1 py-1 text-xs text-foreground placeholder-foreground-muted outline-none focus:border-signal"
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear search"
                className="text-xs text-foreground-muted hover:text-foreground">clear</button>
            )}
          </div>
        )}
        <div className="divide-y divide-line">
          {visibleFindings.map((f) => (
            <article key={f.messageId} data-finding-id={f.messageId} className="py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-foreground-muted">
                <span className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${SEV_DOT[f.severity ?? 'low'] ?? 'bg-line'}`}
                    title={`${f.severity ?? 'low'} severity`} />
                  <span className="font-mono">{f.tool}{f.version ? `@${f.version}` : ''}</span>
                </span>
                {f.type && <span>{f.type}</span>}
                {f.status && <span className={STATUS_LABEL[f.status] ?? ''}>{f.status}</span>}
                {(f.agents_hit ?? 1) > 1 && (
                  <span className="text-merge" title="distinct agents that hit this finding">
                    ×{f.agents_hit} agents hit
                  </span>
                )}
                <span className="ml-auto font-mono">
                  {f.sender} · {f.sentTime ? new Date(f.sentTime).toLocaleTimeString() : ''}
                </span>
              </div>
              <h3 className="mt-1 text-lg font-medium text-foreground">{f.title}</h3>
              {f.body && <p className="mt-1 text-sm leading-6 text-foreground-muted">{f.body}</p>}
              {f.snippet && (
                <pre className="mt-2 overflow-x-auto border border-line bg-background p-2 font-mono text-xs text-foreground-muted">{f.snippet}</pre>
              )}
              {f.link && <a className="mt-1 block text-xs text-signal hover:underline" href={f.link}>{f.link}</a>}
              <div className="mt-2 flex gap-4 text-xs text-foreground-muted">
                {(['confirmed_by', 'refuted_by'] as const).map((key) => (
                  <button key={key}
                    onClick={async () => {
                      const r = await fetch(`/api/findings/${f.messageId}/react`, {
                        method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ key, value: 'supervisor-demo', op: 'add' }),
                      });
                      if (r.ok) {
                        const j = await r.json();
                        setFindings((cur) => cur.map((x) =>
                          x.messageId === f.messageId ? { ...x, status: j.status } : x));
                      }
                    }}
                    className="hover:text-foreground">
                    {key === 'confirmed_by' ? 'confirm' : 'refute'}
                  </button>
                ))}
              </div>
              {(f.replies?.length ?? 0) > 0 && (
                <div className="mt-2 space-y-1 border-l border-line pl-3">
                  {f.replies!.map((r, i) => (
                    <div key={i} className="text-xs text-foreground-muted">
                      <span className="font-mono">{r.agent_id ?? 'agent'}</span>
                      {r.reply_kind === 'dedup_merge' && (
                        <span className="mx-1 text-merge">merged</span>
                      )}
                      {r.reply_kind === 'escalation' && (
                        <span className="mx-1 text-signal">escalated</span>
                      )}
                      {r.body}
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
        {room && findings.length === 0 && (
          <div className="py-8 text-sm text-foreground-muted">no findings filed in {room} yet</div>
        )}
        {room && findings.length > 0 && visibleFindings.length === 0 && (
          <div className="py-8 text-sm text-foreground-muted">
            nothing loaded in {room} matches &quot;{query}&quot;
          </div>
        )}
      </main>
    </div>
  );
}
