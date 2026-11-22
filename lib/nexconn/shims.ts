// Server-side browser-global shims for @nexconn/chat (web SDK) running in
// Node.js route handlers. Same surface as spikes/node-dom-shims.mjs — kept as
// a separate copy because lib/ is the production path and spikes/ is throwaway.
// Import for side effects BEFORE importing @nexconn/chat.

const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.window === 'undefined') g.window = globalThis;

const store = new Map<string, string>();
const storageShim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
// Node's own localStorage throws without --localstorage-file; always override.
g.localStorage = storageShim;
g.sessionStorage = storageShim;

if (typeof g.location === 'undefined') {
  g.location = {
    protocol: 'http:', href: 'http://localhost/', host: 'localhost',
    hostname: 'localhost', origin: 'http://localhost',
    pathname: '/', search: '', hash: '',
  };
}
if (typeof g.document === 'undefined') {
  g.document = {
    documentElement: {},
    createElement: () => ({ style: {}, setAttribute() {}, getElementsByTagName: () => [] }),
    getElementsByTagName: () => [],
    addEventListener() {}, removeEventListener() {},
    hidden: false, visibilityState: 'visible',
  };
}
if (typeof g.addEventListener !== 'function') {
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
}

// Minimal XMLHttpRequest over fetch — the engine's REST calls use XHR, which
// Node lacks. Same contract as spikes/node-dom-shims.mjs.
if (typeof g.XMLHttpRequest === 'undefined') {
  class XMLHttpRequestShim {
    readyState = 0;
    status = 0;
    statusText = '';
    response: unknown = null;
    responseText = '';
    responseType = '';
    responseURL = '';
    timeout = 0;
    withCredentials = false;
    upload = { addEventListener() {}, removeEventListener() {}, onprogress: null };
    onreadystatechange: ((ev: unknown) => void) | null = null;
    onload: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    ontimeout: ((ev: unknown) => void) | null = null;
    onabort: ((ev: unknown) => void) | null = null;
    onloadend: ((ev: unknown) => void) | null = null;
    onprogress: ((ev: unknown) => void) | null = null;
    private _headers: Record<string, string> = {};
    private _method = 'GET';
    private _url = '';
    private _aborted = false;
    private _controller: AbortController | null = null;
    private _responseHeaders = '';

    open(method: string, url: string) {
      this._method = method;
      this._url = url;
      this.readyState = 1;
      this._emitState();
    }
    setRequestHeader(name: string, value: string) { this._headers[name] = value; }
    getAllResponseHeaders() { return this._responseHeaders; }
    getResponseHeader(name: string) {
      const m = this._responseHeaders.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
      return m ? m[1].trim() : null;
    }
    abort() {
      this._aborted = true;
      this._controller?.abort();
      this.readyState = 0;
      this.onabort?.({ type: 'abort', target: this });
      this.onloadend?.({ type: 'loadend', target: this });
    }
    private _emitState() { this.onreadystatechange?.({ target: this }); }
    send(body: unknown = null) {
      if (this.readyState !== 1) return;
      this._controller = new AbortController();
      const timer = setTimeout(() => { this._aborted = true; this._controller?.abort('timeout'); },
        this.timeout > 0 ? this.timeout : 30000);
      fetch(this._url, {
        method: this._method,
        headers: this._headers,
        body: this._method === 'GET' || this._method === 'HEAD' ? undefined : (body as BodyInit | undefined),
        signal: this._controller.signal,
        redirect: 'follow',
      }).then(async (res) => {
        if (this._aborted) return;
        this.status = res.status;
        this.statusText = res.statusText;
        this.responseURL = res.url;
        this.readyState = 2;
        this._responseHeaders = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
        this._emitState();
        this.readyState = 3;
        this._emitState();
        const type = this.responseType || 'text';
        const payload = type === 'arraybuffer' ? await res.arrayBuffer()
          : type === 'blob' ? await res.blob()
          : type === 'json' ? JSON.parse(await res.text())
          : await res.text();
        if (this._aborted) return;
        this.response = payload;
        this.responseText = typeof payload === 'string' ? payload : JSON.stringify(payload);
        this.readyState = 4;
        this._emitState();
        this.onload?.({ type: 'load', target: this });
        this.onloadend?.({ type: 'loadend', target: this });
      }).catch(() => {
        if (this._aborted) { this.ontimeout?.({ type: 'timeout', target: this }); }
        else { this.status = 0; this.onerror?.({ type: 'error', target: this }); }
        this.onloadend?.({ type: 'loadend', target: this });
      }).finally(() => clearTimeout(timer));
    }
    addEventListener(kind: string, fn: (ev: unknown) => void) {
      (this as unknown as Record<string, unknown>)[`on${kind}`] = fn;
    }
    removeEventListener(kind: string) {
      (this as unknown as Record<string, unknown>)[`on${kind}`] = null;
    }
    dispatchEvent() { return true; }
  }
  g.XMLHttpRequest = XMLHttpRequestShim;
}

export {};
