import { describe, it, expect } from 'vitest';
import { fingerprint } from '@/lib/fingerprint';
import { tokenize, jaccard, dedupScore } from '@/lib/dedup/tokens';

const base = {
  tool: 'nexconn', version: '26.5.1', type: 'bug' as const,
  severity: 'medium' as const, title: 'token fails', body: 'b',
  snippet: '', link: '', agent_id: 'agent-a-01',
};

describe('fingerprint', () => {
  it('is stable for identical payloads', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });
  it('severity default is normalized before hashing', () => {
    expect(fingerprint(base)).toBe(
      fingerprint({ ...base, severity: 'medium' }));
  });
  it('changes when severity changes', () => {
    expect(fingerprint(base)).not.toBe(
      fingerprint({ ...base, severity: 'high' }));
  });
  it('changes when snippet or link changes', () => {
    expect(fingerprint(base)).not.toBe(
      fingerprint({ ...base, snippet: 'x' }));
    expect(fingerprint(base)).not.toBe(
      fingerprint({ ...base, link: 'https://a.b' }));
  });
});

describe('dedup tokens', () => {
  it('jaccard over tokenized text', () => {
    const a = tokenize('token refresh fails silently');
    const b = tokenize('token refresh fails');
    expect(jaccard(a, b)).toBeGreaterThan(0.5);
    expect(jaccard(tokenize('totally'), tokenize('different words'))).toBe(0);
  });
  it('version bonus raises the score', () => {
    const a = tokenize('x y'); const b = tokenize('x y');
    expect(dedupScore(a, b, '1.0', '1.0')).toBeGreaterThan(dedupScore(a, b, '1.0', '2.0'));
  });
});
