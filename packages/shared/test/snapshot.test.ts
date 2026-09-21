import { describe, expect, it } from 'vitest';
import { buildQuizSnapshot, type SnapshotQuizInput } from '../src/snapshot.js';
import type { SessionSettings } from '../src/types.js';

const settings = (over: Partial<SessionSettings> = {}): SessionSettings => ({
  maxParticipants: 500,
  showQuestionOnPlayer: false,
  randomizeQuestions: false,
  randomizeAnswers: false,
  allowLateJoin: true,
  ...over,
});

const quiz: SnapshotQuizInput = {
  id: 'quiz-1',
  title: 'T',
  description: 'd',
  questions: [
    {
      id: 'q1',
      order: 0,
      type: 'SINGLE',
      text: 'q1',
      timeLimitSec: 20,
      pointsMode: 'STANDARD',
      explanation: 'e',
      options: [
        { id: 'o1', order: 0, text: 'a', isCorrect: true },
        { id: 'o2', order: 1, text: 'b', isCorrect: false },
        { id: 'o3', order: 2, text: 'c', isCorrect: false },
        { id: 'o4', order: 3, text: 'd', isCorrect: false },
      ],
    },
    {
      id: 'q2',
      order: 1,
      type: 'TRUE_FALSE',
      text: 'q2',
      timeLimitSec: 10,
      pointsMode: 'NONE',
      options: [
        { id: 't', order: 0, text: 'True', isCorrect: true },
        { id: 'f', order: 1, text: 'False', isCorrect: false },
      ],
    },
  ],
};

/** Deterministic LCG so tests don't depend on Math.random. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('buildQuizSnapshot', () => {
  it('preserves order and re-indexes when all flags are off', () => {
    const s = buildQuizSnapshot(quiz, settings(), mulberry32(1));
    expect(s.quizId).toBe('quiz-1');
    expect(s.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(s.questions.map((q) => q.index)).toEqual([0, 1]);
    expect(s.questions[0]!.options.map((o) => o.id)).toEqual(['o1', 'o2', 'o3', 'o4']);
    expect(s.questions[0]!.options.map((o) => o.index)).toEqual([0, 1, 2, 3]);
  });

  it('shuffles SINGLE options but never TRUE_FALSE, re-indexed, with seeded rng', () => {
    const rng = mulberry32(42);
    const s = buildQuizSnapshot(quiz, settings({ randomizeAnswers: true }), rng);
    const singleIds = s.questions[0]!.options.map((o) => o.id);
    expect([...singleIds].sort()).toEqual(['o1', 'o2', 'o3', 'o4']);
    expect(singleIds).not.toEqual(['o1', 'o2', 'o3', 'o4']);
    expect(s.questions[0]!.options.map((o) => o.index)).toEqual([0, 1, 2, 3]);
    // TRUE_FALSE stays put
    expect(s.questions[1]!.options.map((o) => o.text)).toEqual(['True', 'False']);
  });

  it('shuffles question order only when randomizeQuestions is on', () => {
    const keep = buildQuizSnapshot(quiz, settings(), mulberry32(7));
    expect(keep.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    // Deterministic rng = always 0 forces a stable, different permutation for 3+ items
    const q3: SnapshotQuizInput = {
      ...quiz,
      questions: [...quiz.questions, { ...quiz.questions[0]!, id: 'q3', order: 2 }],
    };
    const shuffled = buildQuizSnapshot(q3, settings({ randomizeQuestions: true }), () => 0);
    expect(shuffled.questions.map((q) => q.id)).toEqual(['q2', 'q3', 'q1']);
    expect([...shuffled.questions.map((q) => q.id)].sort()).toEqual(['q1', 'q2', 'q3']);
  });

  it('CONTENT slides keep their position when questions are shuffled', () => {
    const slide = (id: string, order: number) => ({
      id,
      order,
      type: 'CONTENT',
      text: `slide ${id}`,
      timeLimitSec: 20,
      pointsMode: 'STANDARD' as const,
      explanation: 'body',
      options: [],
    });
    const q5: SnapshotQuizInput = {
      ...quiz,
      questions: [
        slide('s0', 0),
        { ...quiz.questions[0]!, id: 'q1', order: 1 },
        { ...quiz.questions[1]!, id: 'q2', order: 2 },
        { ...quiz.questions[0]!, id: 'q3', order: 3 },
        slide('s4', 4),
      ],
    };
    // rng() = 0 is a strong permutation; slides must not move anyway.
    const s = buildQuizSnapshot(q5, settings({ randomizeQuestions: true }), () => 0);
    expect(s.questions.map((q) => q.id)).toEqual(['s0', 'q2', 'q3', 'q1', 's4']);
    expect(s.questions.map((q) => q.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('POLL loses isCorrect + pointsMode; CONTENT keeps only text/body/media', () => {
    const q4: SnapshotQuizInput = {
      ...quiz,
      questions: [
        {
          id: 'p1',
          order: 0,
          type: 'POLL',
          text: 'vote',
          timeLimitSec: 20,
          pointsMode: 'DOUBLE',
          options: [
            { id: 'o1', order: 0, text: 'a', isCorrect: true },
            { id: 'o2', order: 1, text: 'b', isCorrect: false },
          ],
        },
        {
          id: 'c1',
          order: 1,
          type: 'CONTENT',
          text: 'slide',
          timeLimitSec: 20,
          pointsMode: 'STANDARD',
          explanation: 'the body',
          options: [{ id: 'x', order: 0, text: 'stray', isCorrect: true }],
        },
      ],
    };
    const s = buildQuizSnapshot(q4, settings());
    const poll = s.questions[0]!;
    expect(poll.type).toBe('POLL');
    expect(poll.pointsMode).toBe('NONE');
    expect(poll.options.every((o) => !o.isCorrect)).toBe(true);
    const slide = s.questions[1]!;
    expect(slide.type).toBe('CONTENT');
    expect(slide.pointsMode).toBe('NONE');
    expect(slide.options).toEqual([]);
    expect(slide.explanation).toBe('the body');
  });
});
