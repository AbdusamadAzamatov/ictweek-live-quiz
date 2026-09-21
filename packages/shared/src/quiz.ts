import { z } from 'zod';
import { POINTS_MODES, QUESTION_TYPES, type PointsMode, type QuestionType } from './types.js';

export const TIME_LIMITS = [5, 10, 20, 30, 60, 90, 120, 240] as const;

export const NICKNAME_MAX_LENGTH = 20;

// ---------------------------------------------------------------------------
// Lenient draft schema — what autosave persists. Empty text and any option
// count 0..6 are allowed; strict rules live in validateQuizForPlay.
// ---------------------------------------------------------------------------

export const AnswerOptionDraftSchema = z.object({
  id: z.string().optional(),
  text: z.string().default(''),
  mediaId: z.string().nullable().optional(),
  isCorrect: z.boolean().default(false),
});

export const QuestionDraftSchema = z.object({
  id: z.string().optional(),
  type: z.enum(QUESTION_TYPES).default('SINGLE'),
  text: z.string().default(''),
  mediaId: z.string().nullable().optional(),
  timeLimitSec: z.number().int().default(20),
  pointsMode: z.enum(POINTS_MODES).default('STANDARD'),
  explanation: z.string().default(''),
  options: z.array(AnswerOptionDraftSchema).max(6).default([]),
});

export const QuizDraftSchema = z.object({
  title: z.string().default(''),
  description: z.string().default(''),
  coverMediaId: z.string().nullable().optional(),
  questions: z.array(QuestionDraftSchema).default([]),
});

export type AnswerOptionDraft = z.infer<typeof AnswerOptionDraftSchema>;
export type QuestionDraft = z.infer<typeof QuestionDraftSchema>;
export type QuizDraft = z.infer<typeof QuizDraftSchema>;

export const SessionSettingsSchema = z
  .object({
    maxParticipants: z.number().int().min(1).max(2000).default(500),
    showQuestionOnPlayer: z.boolean().default(false),
    randomizeQuestions: z.boolean().default(false),
    randomizeAnswers: z.boolean().default(false),
    allowLateJoin: z.boolean().default(true),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Strict play validation — must return [] before a session can be created.
// ---------------------------------------------------------------------------

export type Issue = { path: string; questionIndex?: number; message: string };

export type QuizForValidation = {
  title: string;
  description?: string | null;
  questions: Array<{
    type: QuestionType;
    text: string;
    mediaId?: string | null;
    timeLimitSec: number;
    pointsMode: PointsMode;
    explanation?: string | null;
    options: Array<{ text: string; mediaId?: string | null; isCorrect: boolean }>;
  }>;
};

export function validateQuizForPlay(quiz: QuizForValidation): Issue[] {
  const issues: Issue[] = [];
  const at = (path: string, questionIndex: number | undefined, message: string) =>
    issues.push(questionIndex === undefined ? { path, message } : { path, questionIndex, message });

  if (quiz.title.trim().length < 1 || quiz.title.length > 95) {
    at('title', undefined, 'Title must be 1–95 characters');
  }
  if ((quiz.description ?? '').length > 500) {
    at('description', undefined, 'Description must be at most 500 characters');
  }
  if (quiz.questions.length < 1) {
    at('questions', undefined, 'Quiz needs at least 1 question');
  }

  quiz.questions.forEach((q, i) => {
    const base = `questions.${i}`;

    if (q.type === 'POLL' || q.type === 'CONTENT') {
      at(`${base}.type`, i, `Question type ${q.type} is not supported in this release`);
      return;
    }

    const textLen = q.text.trim().length;
    if (textLen < 1 || q.text.length > 120) {
      at(`${base}.text`, i, 'Question text must be 1–120 characters (media alone is not enough)');
    }

    if (q.type === 'TRUE_FALSE') {
      const labelsOk =
        q.options.length === 2 && q.options[0]?.text === 'True' && q.options[1]?.text === 'False';
      if (!labelsOk) {
        at(`${base}.options`, i, 'TRUE_FALSE needs exactly 2 options labelled True and False');
      }
      if (q.options.filter((o) => o.isCorrect).length !== 1) {
        at(`${base}.options`, i, 'TRUE_FALSE needs exactly 1 correct option');
      }
    } else {
      if (q.options.length < 2 || q.options.length > 6) {
        at(`${base}.options`, i, `${q.type} needs 2–6 options`);
      }
      const correct = q.options.filter((o) => o.isCorrect).length;
      if (q.type === 'SINGLE' && correct !== 1) {
        at(`${base}.options`, i, 'SINGLE needs exactly 1 correct option');
      }
      if (q.type === 'MULTI' && correct < 1) {
        at(`${base}.options`, i, 'MULTI needs at least 1 correct option');
      }
    }

    q.options.forEach((o, oi) => {
      const hasText = o.text.trim().length >= 1 && o.text.length <= 75;
      if (!hasText && !o.mediaId) {
        at(`${base}.options.${oi}.text`, i, 'Option needs text of 1–75 characters or media');
      }
    });

    if (!(TIME_LIMITS as readonly number[]).includes(q.timeLimitSec)) {
      at(`${base}.timeLimitSec`, i, `timeLimitSec must be one of ${TIME_LIMITS.join(', ')}`);
    }
    if (!(POINTS_MODES as readonly string[]).includes(q.pointsMode)) {
      at(`${base}.pointsMode`, i, 'pointsMode must be NONE, STANDARD or DOUBLE');
    }
    if ((q.explanation ?? '').length > 500) {
      at(`${base}.explanation`, i, 'Explanation must be at most 500 characters');
    }
  });

  return issues;
}

// ---------------------------------------------------------------------------
// Nicknames
// ---------------------------------------------------------------------------

export type NormalizedNickname =
  { ok: true; value: string; key: string } | { ok: false; reason: 'EMPTY' | 'TOO_LONG' };

export function normalizeNickname(raw: string): NormalizedNickname {
  const value = raw
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length === 0) return { ok: false, reason: 'EMPTY' };
  if ([...value].length > NICKNAME_MAX_LENGTH) return { ok: false, reason: 'TOO_LONG' };
  return { ok: true, value, key: value.toLowerCase() };
}
