// Replay fingerprint (srd.md §5.2): sha256 over the canonical tuple. Severity
// is normalized AFTER its default; omitted snippet/link canonicalize to ''.
import { createHash } from 'node:crypto';
import type { FindingInput } from './validation/finding';

export function fingerprint(f: FindingInput): string {
  return createHash('sha256').update([
    f.tool, f.version, f.type, f.title, f.body,
    f.severity, f.snippet ?? '', f.link ?? '', f.agent_id,
  ].join('|')).digest('hex');
}
