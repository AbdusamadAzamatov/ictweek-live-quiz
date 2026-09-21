import type { PointsMode } from './types.js';

export const MULTI_POINTS_PER_CORRECT_STANDARD = 500;

/**
 * Linear speed factor: 1 for answers in under 500 ms, decaying to 0.5 at the
 * deadline. Response time is clamped to [0, durationMs].
 */
export function speedFactor(rtMs: number, durationMs: number): number {
  if (rtMs < 500) return 1;
  if (durationMs <= 0) return 0.5;
  const clamped = Math.min(Math.max(rtMs, 0), durationMs);
  return 1 - clamped / durationMs / 2;
}

export function maxPoints(mode: PointsMode): number {
  if (mode === 'DOUBLE') return 2000;
  if (mode === 'STANDARD') return 1000;
  return 0;
}

export function multiPerCorrect(mode: PointsMode): number {
  if (mode === 'DOUBLE') return 2 * MULTI_POINTS_PER_CORRECT_STANDARD;
  if (mode === 'STANDARD') return MULTI_POINTS_PER_CORRECT_STANDARD;
  return 0;
}

export type ScoreableQuestion = {
  type: 'SINGLE' | 'TRUE_FALSE' | 'MULTI' | (string & {});
  pointsMode: PointsMode;
  timeLimitSec: number;
  options: Array<{ id: string; isCorrect: boolean }>;
};

export type ScoreResult = { isCorrect: boolean; points: number };

export function scoreSubmission(
  question: ScoreableQuestion,
  optionIds: string[],
  rtMs: number,
): ScoreResult {
  const factor = speedFactor(rtMs, question.timeLimitSec * 1000);

  if (question.type === 'MULTI') {
    const selected = [...new Set(optionIds)];
    if (selected.length === 0) return { isCorrect: false, points: 0 };
    const byId = new Map(question.options.map((o) => [o.id, o]));
    // An unknown id or an incorrect option anywhere in the selection → 0.
    if (selected.some((id) => !byId.get(id)?.isCorrect)) {
      return { isCorrect: false, points: 0 };
    }
    const correctCount = question.options.filter((o) => o.isCorrect).length;
    const isCorrect = selected.length === correctCount;
    const points = Math.round(selected.length * multiPerCorrect(question.pointsMode) * factor);
    return { isCorrect, points };
  }

  // SINGLE / TRUE_FALSE (and any future single-answer type): exactly one id.
  const selectedId = optionIds.length === 1 ? optionIds[0] : undefined;
  const option = question.options.find((o) => o.id === selectedId);
  const isCorrect = option?.isCorrect === true;
  const points = isCorrect ? Math.round(maxPoints(question.pointsMode) * factor) : 0;
  return { isCorrect, points };
}
