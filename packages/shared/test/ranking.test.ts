import { describe, expect, it } from 'vitest';
import { rankParticipants } from '../src/ranking.js';

const p = (
  id: string,
  score: number,
  correctCount = 0,
  totalResponseMs = 0,
  joinedAt: string | Date = '2026-01-01T00:00:00Z',
) => ({ id, score, correctCount, totalResponseMs, joinedAt });

describe('rankParticipants', () => {
  it('orders by score desc', () => {
    const r = rankParticipants([p('a', 100), p('b', 500), p('c', 300)]);
    expect(r.map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
  });

  it('tie on score → correctCount desc', () => {
    const r = rankParticipants([p('a', 100, 1), p('b', 100, 3), p('c', 100, 2)]);
    expect(r.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('tie on score+count → totalResponseMs asc', () => {
    const r = rankParticipants([p('a', 100, 1, 900), p('b', 100, 1, 100), p('c', 100, 1, 500)]);
    expect(r.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('then joinedAt asc', () => {
    const r = rankParticipants([
      p('a', 100, 1, 100, '2026-01-02T00:00:00Z'),
      p('b', 100, 1, 100, '2026-01-01T00:00:00Z'),
    ]);
    expect(r.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('finally id asc', () => {
    const r = rankParticipants([
      p('z', 100, 1, 100, '2026-01-01T00:00:00Z'),
      p('a', 100, 1, 100, '2026-01-01T00:00:00Z'),
    ]);
    expect(r.map((x) => x.id)).toEqual(['a', 'z']);
  });

  it('returns sequential ranks 1..n and preserves entries', () => {
    const input = [p('x', 5), p('y', 50), p('z', 500), p('w', 5)];
    const r = rankParticipants(input);
    expect(r).toHaveLength(4);
    expect(r.map((x) => x.id)).toEqual(['z', 'y', 'w', 'x']);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3, 4]);
    expect(new Set(r.map((x) => x.id))).toEqual(new Set(['x', 'y', 'z', 'w']));
  });

  it('accepts Date joinedAt', () => {
    const r = rankParticipants([
      p('a', 100, 1, 100, new Date('2026-01-02')),
      p('b', 100, 1, 100, new Date('2026-01-01')),
    ]);
    expect(r.map((x) => x.id)).toEqual(['b', 'a']);
  });
});
