export type Rankable = {
  id: string;
  score: number;
  correctCount: number;
  totalResponseMs: number;
  joinedAt: Date | string;
};

/**
 * Deterministic total order — no shared ranks:
 * score desc, correctCount desc, totalResponseMs asc, joinedAt asc, id asc.
 * Rank is the 1-based position.
 */
export function rankParticipants<T extends Rankable>(list: T[]): Array<T & { rank: number }> {
  const sorted = [...list].sort(
    (a, b) =>
      b.score - a.score ||
      b.correctCount - a.correctCount ||
      a.totalResponseMs - b.totalResponseMs ||
      new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return sorted.map((p, i) => ({ ...p, rank: i + 1 }));
}
