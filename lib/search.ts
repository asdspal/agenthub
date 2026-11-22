// Application-side search over loaded finding cards (R-003). No Nexconn
// search API exists — filter the payloads already fetched (srd.md §5).
export interface Searchable {
  title?: string; body?: string; tool?: string; version?: string;
}

const has = (f: Searchable, field: keyof Searchable, q: string) =>
  String(f[field] ?? '').toLowerCase().includes(q);

export function filterFindings<T extends Searchable>(cards: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter((f) =>
    has(f, 'title', q) || has(f, 'body', q) || has(f, 'tool', q) || has(f, 'version', q));
}

export function filterRooms(rooms: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? rooms.filter((r) => r.toLowerCase().includes(q)) : rooms;
}
