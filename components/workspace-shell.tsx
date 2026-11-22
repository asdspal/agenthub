'use client';
// Workspace shell: client-only ChatUI mount (A-4a path).
// Bootstrap order per the documented quickstart:
//   NCEngine.initialize -> NCChatUIApplication.initialize -> ready()
//   -> mount nc-chat-ui-app-provider -> NCEngine.connect({token})
import { useEffect, useRef, useState } from 'react';
import FindingsPanel from './findings-panel';

declare global {
  interface Window { __ncApp?: unknown }
}

export default function WorkspaceShell() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState('booting');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { NCEngine, LogLevel } = await import('@nexconn/chat');
        const { NCChatUIApplication } = await import('@nexconn/chatui');
        if (cancelled) return;

        NCEngine.initialize({
          appKey: process.env.NEXT_PUBLIC_NEXCONN_APP_KEY ?? '',
          logLevel: LogLevel.WARN,
        });
        setState('engine-initialized');

        const app = NCChatUIApplication.initialize({
          hooks: {
            reqUserProfiles: async (ids: string[]) =>
              ids.map((userId) => ({ userId, name: userId })),
            reqGroupProfiles: async (ids: string[]) =>
              ids.map((groupId) => ({ groupId, name: groupId, memberCount: 0 })),
            reqGroupMembers: async () => [],
            reqSystemProfiles: async (ids: string[]) =>
              ids.map((systemId) => ({ systemId, name: systemId })),
          },
          language: 'en_US',
        });
        if (!app) throw new Error('ChatUI initialize returned null');
        window.__ncApp = app;
        setState('chatui-initialized');

        app.ready();
        if (hostRef.current && !hostRef.current.querySelector('nc-chat-ui-app-provider')) {
          const el = document.createElement('nc-chat-ui-app-provider');
          el.style.cssText = 'display:block;width:100%;height:100%';
          hostRef.current.appendChild(el);
        }
        setState('provider-mounted');

        const res = await fetch('/api/session/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: 'supervisor-demo' }),
        });
        const { token } = await res.json();
        const conn = await NCEngine.connect({ token });
        if (!conn.isOk) throw new Error(`connect code=${conn.code}`);
        setState('connected');

        // Open the selected room in ChatUI too (probe-proven on
        // CommunitySubChannelIdentifier). Its message pane stays mostly empty —
        // custom messages don't render there (the A-4b finding itself).
        const chatModule = await import('@nexconn/chat');
        const lastRoom = (window as unknown as { __agenthubRoom?: string }).__agenthubRoom;
        const openRoom = (room: string) => {
          try {
            (app as { openChannel?: (c: unknown) => void }).openChannel?.(
              new chatModule.CommunitySubChannelIdentifier('agenthub', room));
          } catch { /* openChannel is best-effort */ }
        };
        window.addEventListener('agenthub:room', (e) => {
          const room = (e as CustomEvent<string>).detail;
          if (room) openRoom(room);
        });
        if (lastRoom) openRoom(lastRoom);
      } catch (e) {
        setState('error: ' + String(e instanceof Error ? e.message : e).slice(0, 200));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const connected = state === 'connected';
  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-foreground-muted">
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-merge' : 'bg-signal'}`} />
        <span>agenthub</span>
        <span>{connected ? 'connected' : state.startsWith('error') ? 'connection failed — retrying' : 'connecting…'}</span>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="flex w-6 shrink-0 flex-col items-center gap-1 border-r border-line pt-3"
          title="live Nexconn session (ChatUI-mounted)">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-merge' : 'bg-line'}`} />
        </div>
        <div ref={hostRef} className="w-px shrink-0 overflow-hidden" aria-hidden />
        <div className="flex-1 min-w-0">
          <FindingsPanel />
        </div>
      </div>
    </div>
  );
}
