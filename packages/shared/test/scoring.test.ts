import { describe, expect, it } from 'vitest';
import {
  MULTI_POINTS_PER_CORRECT_STANDARD,
  maxPoints,
  multiPerCorrect,
  scoreSubmission,
  speedFactor,
  type ScoreableQuestion,
} from '../src/scoring.js';

describe('speedFactor', () => {
  it('rt 0 → 1', () => expect(speedFactor(0, 10_000)).toBe(1));
  it('rt 499 → 1', () => expect(speedFactor(499, 10_000)).toBe(1));
  it('rt 500 on 10 s → 0.975', () => expect(speedFactor(500, 10_000)).toBe(0.975));
  it('rt 501 on 10 s → ≈0.97495', () => expect(speedFactor(501, 10_000)).toBeCloseTo(0.97495, 5));
  it('rt == duration → 0.5', () => expect(speedFactor(10_000, 10_000)).toBe(0.5));
  it('rt > duration → 0.5', () => expect(speedFactor(99_000, 10_000)).toBe(0.5));
  it('negative rt → 1', () => expect(speedFactor(-50, 10_000)).toBe(1));
});

describe('maxPoints / multiPerCorrect', () => {
  it('maps modes', () => {
    expect(maxPoints('NONE')).toBe(0);
    expect(maxPoints('STANDARD')).toBe(1000);
    expect(maxPoints('DOUBLE')).toBe(2000);
    expect(multiPerCorrect('NONE')).toBe(0);
    expect(multiPerCorrect('STANDARD')).toBe(MULTI_POINTS_PER_CORRECT_STANDARD);
    expect(multiPerCorrect('DOUBLE')).toBe(1000);
  });
});

const single: ScoreableQuestion = {
  type: 'SINGLE',
  pointsMode: 'STANDARD',
  timeLimitSec: 20,
  options: [
    { id: 'a', isCorrect: true },
    { id: 'b', isCorrect: false },
  ],
};

const tf: ScoreableQuestion = {
  type: 'TRUE_FALSE',
  pointsMode: 'STANDARD',
  timeLimitSec: 20,
  options: [
    { id: 't', isCorrect: true },
    { id: 'f', isCorrect: false },
  ],
};

const multi: ScoreableQuestion = {
  type: 'MULTI',
  pointsMode: 'STANDARD',
  timeLimitSec: 20,
  options: [
    { id: 'a', isCorrect: true },
    { id: 'b', isCorrect: true },
    { id: 'c', isCorrect: false },
    { id: 'd', isCorrect: false },
  ],
};

describe('scoreSubmission SINGLE', () => {
  it('correct fast → 1000', () =>
    expect(scoreSubmission(single, ['a'], 100)).toEqual({ isCorrect: true, points: 1000 }));
  it('correct rt 2000 / 30 s → 967 (documented worked example)', () =>
    expect(scoreSubmission({ ...single, timeLimitSec: 30 }, ['a'], 2000)).toEqual({
      isCorrect: true,
      points: 967,
    }));
  it('wrong → 0 / false', () =>
    expect(scoreSubmission(single, ['b'], 100)).toEqual({ isCorrect: false, points: 0 }));
  it('DOUBLE correct fast → 2000', () =>
    expect(scoreSubmission({ ...single, pointsMode: 'DOUBLE' }, ['a'], 100)).toEqual({
      isCorrect: true,
      points: 2000,
    }));
  it('NONE correct → 0 points but isCorrect true', () =>
    expect(scoreSubmission({ ...single, pointsMode: 'NONE' }, ['a'], 100)).toEqual({
      isCorrect: true,
      points: 0,
    }));
});

describe('scoreSubmission TRUE_FALSE', () => {
  it('behaves like SINGLE', () => {
    expect(scoreSubmission(tf, ['t'], 100)).toEqual({ isCorrect: true, points: 1000 });
    expect(scoreSubmission(tf, ['f'], 100)).toEqual({ isCorrect: false, points: 0 });
  });
});

describe('scoreSubmission MULTI (2 correct of 4, STANDARD)', () => {
  it('both correct fast → 1000 & isCorrect', () =>
    expect(scoreSubmission(multi, ['a', 'b'], 100)).toEqual({ isCorrect: true, points: 1000 }));
  it('one correct only → 500 & not fully correct', () =>
    expect(scoreSubmission(multi, ['a'], 100)).toEqual({ isCorrect: false, points: 500 }));
  it('one correct + one wrong → 0 & false', () =>
    expect(scoreSubmission(multi, ['a', 'c'], 100)).toEqual({ isCorrect: false, points: 0 }));
  it('all four → 0 & false', () =>
    expect(scoreSubmission(multi, ['a', 'b', 'c', 'd'], 100)).toEqual({
      isCorrect: false,
      points: 0,
    }));
  it('DOUBLE both correct fast → 2000', () =>
    expect(scoreSubmission({ ...multi, pointsMode: 'DOUBLE' }, ['a', 'b'], 100)).toEqual({
      isCorrect: true,
      points: 2000,
    }));
  it('rt 2000 / 30 s both correct → round(1000·0.9667) = 967', () =>
    expect(scoreSubmission({ ...multi, timeLimitSec: 30 }, ['a', 'b'], 2000)).toEqual({
      isCorrect: true,
      points: 967,
    }));
});
