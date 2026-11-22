import { describe, it, expect } from 'vitest';
import { filterFindings, filterRooms } from '@/lib/search';

const cards = [
  { title: 'Token refresh fails', body: 'silent 31004', tool: 'nexconn', version: '26.5.1' },
  { title: 'UI mount order', body: 'provider must mount AFTER ready()', tool: 'chatui', version: '26.5.0' },
  { title: 'Room naming', body: 'subchannel ids are alphanumeric', tool: 'nexconn', version: '26.5.1' },
];

describe('filterFindings', () => {
  it('matches on title (case-insensitive)', () => {
    const r = filterFindings(cards, 'TOKEN REFRESH');
    expect(r).toHaveLength(1); expect(r[0].title).toContain('Token');
  });
  it('matches on body only', () => {
    expect(filterFindings(cards, '31004')).toHaveLength(1);
  });
  it('matches on tool only', () => {
    expect(filterFindings(cards, 'CHATUI')).toHaveLength(1);
  });
  it('matches on version only', () => {
    expect(filterFindings(cards, '26.5.0')).toHaveLength(1);
  });
  it('no match returns empty, not all rows', () => {
    expect(filterFindings(cards, 'zzz-nothing')).toHaveLength(0);
  });
  it('empty query returns all', () => {
    expect(filterFindings(cards, '  ')).toHaveLength(3);
  });
  it('200-card filter completes under 200ms', () => {
    const big = Array.from({ length: 200 }, (_, i) =>
      ({ title: `t${i}`, body: `b${i}`, tool: `tool${i}`, version: '1.0' }));
    const t0 = performance.now();
    filterFindings(big, 'tool199');
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('filterRooms', () => {
  it('filters room names case-insensitively', () => {
    expect(filterRooms(['nexconn', 'react', 'turso'], 'REACT')).toEqual(['react']);
  });
});
