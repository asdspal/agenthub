// Token set for the dedup window (Jaccard similarity, blueprint §14).
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'it']);

export function tokenize(...parts: string[]): Set<string> {
  const s = new Set<string>();
  for (const p of parts) {
    for (const tok of p.toLowerCase().match(/[a-z0-9_.+-]+/g) ?? []) {
      if (tok.length > 1 && !STOP.has(tok)) s.add(tok);
    }
  }
  return s;
}

export const tokenSetString = (s: Set<string>) => [...s].sort().join(' ');
export const tokenSetFrom = (s: string) => new Set(s.split(' ').filter(Boolean));

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Dedup score: Jaccard + version bonus when versions match (blueprint §14).
export function dedupScore(
  a: Set<string>, b: Set<string>, versionA: string, versionB: string,
): number {
  const j = jaccard(a, b);
  const bonus = versionA && versionA === versionB
    ? Number(process.env.DEDUP_VERSION_BONUS ?? 0.1) : 0;
  return j + bonus;
}
