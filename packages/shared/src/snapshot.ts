import type {
  MediaRef,
  PlayableQuestionType,
  PointsMode,
  QuizSnapshot,
  SessionSettings,
} from './types.js';

export type SnapshotOptionInput = {
  id: string;
  order?: number;
  text: string;
  isCorrect: boolean;
  media?: MediaRef | null;
  mediaId?: string | null;
};

export type SnapshotQuestionInput = {
  id: string;
  order?: number;
  type: string;
  text: string;
  media?: MediaRef | null;
  mediaId?: string | null;
  timeLimitSec: number;
  pointsMode: PointsMode;
  explanation?: string | null;
  options: SnapshotOptionInput[];
};

export type SnapshotQuizInput = {
  id: string;
  title: string;
  description?: string | null;
  coverUrl?: string | null;
  cover?: MediaRef | null;
  questions: SnapshotQuestionInput[];
};

function byOrder<T extends { order?: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * Freezes a quiz for a session. Question/answer shuffling happens exactly
 * here, once, when the corresponding setting is on — TRUE_FALSE options are
 * never shuffled. `index` fields are re-numbered after ordering. `rng` is
 * injectable so tests are deterministic.
 */
export function buildQuizSnapshot(
  quiz: SnapshotQuizInput,
  settings: SessionSettings,
  rng: () => number = Math.random,
): QuizSnapshot {
  const shuffle = <T>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = a[i]!;
      a[i] = a[j]!;
      a[j] = tmp;
    }
    return a;
  };

  const questions = byOrder(quiz.questions);
  const ordered = settings.randomizeQuestions ? shuffle(questions) : questions;

  return {
    quizId: quiz.id,
    title: quiz.title,
    description: quiz.description ?? '',
    coverUrl: quiz.coverUrl ?? quiz.cover?.url ?? null,
    questions: ordered.map((q, qi) => {
      const options = byOrder(q.options);
      const finalOptions =
        settings.randomizeAnswers && q.type !== 'TRUE_FALSE' ? shuffle(options) : options;
      return {
        id: q.id,
        index: qi,
        type: q.type as PlayableQuestionType,
        text: q.text,
        media: q.media ?? null,
        timeLimitSec: q.timeLimitSec,
        pointsMode: q.pointsMode,
        explanation: q.explanation ?? '',
        options: finalOptions.map((o, oi) => ({
          id: o.id,
          index: oi,
          text: o.text,
          media: o.media ?? null,
          isCorrect: o.isCorrect,
        })),
      };
    }),
  };
}
