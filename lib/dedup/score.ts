// Dedup matcher (blueprint §14, spike dedup_match.py): hard tool gate,
// Jaccard over title+body tokens, +0.10 same-version bonus, threshold env.
import { tokenize, tokenSetFrom, dedupScore } from './tokens';
import type { FindingRow } from '../store/repositories';
import type { FindingInput } from '../validation/finding';

export interface DedupMatch { row: FindingRow; score: number }

export function bestMatch(
  f: FindingInput, window: FindingRow[],
): DedupMatch | null {
  if (process.env.DEDUP_ENABLED !== 'true') return null;
  const threshold = Number(process.env.DEDUP_THRESHOLD ?? 0.45);
  const cand = tokenize(f.title, f.body);
  let best: DedupMatch | null = null;
  for (const row of window) {
    if (row.tool !== f.tool) continue; // hard tool gate — never cross-tool merge
    const score = dedupScore(cand, tokenSetFrom(row.token_set), f.version, row.version);
    if (score >= threshold && (!best || score > best.score)) {
      best = { row, score };
    }
  }
  return best;
}
