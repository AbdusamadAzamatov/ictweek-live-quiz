import { describe, expect, it } from 'vitest';
import {
  QuizDraftSchema,
  SessionSettingsSchema,
  normalizeNickname,
  validateQuizForPlay,
  type QuizForValidation,
} from '../src/quiz.js';

const opt = (text: string, isCorrect = false) => ({ text, isCorrect });

function validQuiz(): QuizForValidation {
  return {
    title: 'Event quiz',
    description: '',
    questions: [
      {
        type: 'SINGLE',
        text: '2 + 2?',
        timeLimitSec: 20,
        pointsMode: 'STANDARD',
        explanation: '',
        options: [opt('4', true), opt('5')],
      },
      {
        type: 'TRUE_FALSE',
        text: 'The sky is blue',
        timeLimitSec: 10,
        pointsMode: 'NONE',
        explanation: '',
        options: [opt('True', true), opt('False')],
      },
      {
        type: 'MULTI',
        text: 'Pick vowels',
        timeLimitSec: 30,
        pointsMode: 'DOUBLE',
        explanation: '',
        options: [opt('a', true), opt('e', true), opt('b'), opt('c')],
      },
    ],
  };
}

describe('validateQuizForPlay', () => {
  it('accepts a valid 3-type quiz', () => {
    expect(validateQuizForPlay(validQuiz())).toEqual([]);
  });

  it('title bounds', () => {
    expect(validateQuizForPlay({ ...validQuiz(), title: '' })[0]).toMatchObject({
      path: 'title',
    });
    expect(
      validateQuizForPlay({ ...validQuiz(), title: 'x'.repeat(96) }).some(
        (i) => i.path === 'title',
      ),
    ).toBe(true);
  });

  it('question text 121 chars → issue', () => {
    const q = validQuiz();
    q.questions[0]!.text = 'x'.repeat(121);
    expect(validateQuizForPlay(q).some((i) => i.path === 'questions.0.text')).toBe(true);
  });

  it('question with 1 option → issue', () => {
    const q = validQuiz();
    q.questions[0]!.options = [opt('4', true)];
    expect(validateQuizForPlay(q).some((i) => i.path === 'questions.0.options')).toBe(true);
  });

  it('SINGLE with 2 correct → issue', () => {
    const q = validQuiz();
    q.questions[0]!.options = [opt('4', true), opt('also 4', true)];
    expect(validateQuizForPlay(q).some((i) => i.path === 'questions.0.options')).toBe(true);
  });

  it('MULTI with 0 correct → issue', () => {
    const q = validQuiz();
    q.questions[2]!.options = q.questions[2]!.options.map((o) => ({ ...o, isCorrect: false }));
    expect(validateQuizForPlay(q).some((i) => i.path === 'questions.2.options')).toBe(true);
  });

  it('TRUE_FALSE with wrong labels → issue', () => {
    const q = validQuiz();
    q.questions[1]!.options = [opt('Yes', true), opt('No')];
    expect(validateQuizForPlay(q).some((i) => i.path === 'questions.1.options')).toBe(true);
  });

  it('option 76 chars without media → issue', () => {
    const q = validQuiz();
    q.questions[0]!.options[0]!.text = 'x'.repeat(76);
    expect(validateQuizForPlay(q).some((i) => i.path === 'questions.0.options.0.text')).toBe(true);
  });

  it('option empty with media → passes', () => {
    const q = validQuiz();
    q.questions[0]!.options[0] = { text: '', isCorrect: true, mediaId: 'm1' };
    expect(validateQuizForPlay(q).some((i) => i.path === 'questions.0.options.0.text')).toBe(false);
  });

  it('bad timeLimit → issue', () => {
    const q = validQuiz();
    q.questions[0]!.timeLimitSec = 7;
    expect(validateQuizForPlay(q).some((i) => i.path === 'questions.0.timeLimitSec')).toBe(true);
  });

  it('POLL → unsupported issue', () => {
    const q = validQuiz();
    q.questions[0]!.type = 'POLL';
    expect(validateQuizForPlay(q).some((i) => i.message.includes('not supported'))).toBe(true);
  });
});

describe('normalizeNickname', () => {
  it('trims and collapses whitespace', () =>
    expect(normalizeNickname('  jo   hn ')).toEqual({ ok: true, value: 'jo hn', key: 'jo hn' }));
  it('strips control chars', () =>
    expect(normalizeNickname('a\u0007b\u0008c')).toEqual({ ok: true, value: 'abc', key: 'abc' }));
  it('21 chars → TOO_LONG', () =>
    expect(normalizeNickname('x'.repeat(21))).toEqual({ ok: false, reason: 'TOO_LONG' }));
  it('whitespace-only → EMPTY', () =>
    expect(normalizeNickname('   ')).toEqual({ ok: false, reason: 'EMPTY' }));
  it('key is lowercase', () =>
    expect(normalizeNickname('AbC')).toEqual({ ok: true, value: 'AbC', key: 'abc' }));
});

describe('schemas', () => {
  it('QuizDraftSchema tolerates empty draft', () => {
    const d = QuizDraftSchema.parse({});
    expect(d.questions).toEqual([]);
    const q = QuizDraftSchema.parse({ questions: [{ type: 'SINGLE' }] });
    expect(q.questions[0]).toMatchObject({ text: '', options: [], timeLimitSec: 20 });
  });

  it('SessionSettingsSchema defaults', () => {
    expect(SessionSettingsSchema.parse(undefined)).toEqual({
      maxParticipants: 500,
      showQuestionOnPlayer: false,
      randomizeQuestions: false,
      randomizeAnswers: false,
      allowLateJoin: true,
    });
  });
});
