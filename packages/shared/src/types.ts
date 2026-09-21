export const QUESTION_TYPES = ['SINGLE', 'TRUE_FALSE', 'MULTI', 'POLL', 'CONTENT'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export type PlayableQuestionType = 'SINGLE' | 'TRUE_FALSE' | 'MULTI';

export const POINTS_MODES = ['NONE', 'STANDARD', 'DOUBLE'] as const;
export type PointsMode = (typeof POINTS_MODES)[number];

export const SESSION_STATES = [
  'LOBBY',
  'COUNTDOWN',
  'QUESTION_OPEN',
  'QUESTION_CLOSED',
  'ANSWER_REVEAL',
  'LEADERBOARD',
  'FINISHED',
  'CANCELLED',
  'RECOVERY',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export type MediaRef = { url: string; alt: string };

export type SnapshotOption = {
  id: string;
  index: number;
  text: string;
  media: MediaRef | null;
  isCorrect: boolean;
};

export type SnapshotQuestion = {
  id: string;
  index: number;
  type: PlayableQuestionType;
  text: string;
  media: MediaRef | null;
  timeLimitSec: number;
  pointsMode: PointsMode;
  explanation: string;
  options: SnapshotOption[];
};

export type QuizSnapshot = {
  quizId: string;
  title: string;
  description: string;
  coverUrl: string | null;
  questions: SnapshotQuestion[];
};

export type SessionSettings = {
  maxParticipants: number;
  showQuestionOnPlayer: boolean;
  randomizeQuestions: boolean;
  randomizeAnswers: boolean;
  allowLateJoin: boolean;
};

/** Role-filtered live state pushed to sockets (`state` event) and returned by `state:sync`. */
export type GameSnapshot = {
  sessionId: string;
  revision: number;
  state: SessionState;
  /** Date.now() at emit time; clients derive a clock offset for timers. */
  serverTime: number;
  quiz: { title: string; questionCount: number };
  pin: string;
  joinUrl: string;
  locked: boolean;
  participantCount: number;
  questionIndex: number | null;
  question?: {
    attemptId: string;
    index: number;
    type: PlayableQuestionType;
    text: string;
    media: MediaRef | null;
    timeLimitSec: number;
    pointsMode: PointsMode;
    showTextOnPlayer: boolean;
    options: Array<{
      id: string;
      index: number;
      text: string;
      media: MediaRef | null;
      /** Host only until reveal. */
      isCorrect?: boolean;
    }>;
    /** Host only until reveal. */
    explanation?: string;
    openedAt?: string;
    deadlineAt?: string;
  };
  /** Present from ANSWER_REVEAL onwards. */
  results?: {
    answered: number;
    eligible: number;
    distribution: Array<{ optionId: string; count: number }>;
    correctOptionIds: string[];
  };
  /** Top 5 during LEADERBOARD, top 3 at FINISHED. Host gets the full list in `host.participants`. */
  leaderboard?: Array<{
    participantId: string;
    nickname: string;
    score: number;
    rank: number;
    delta: number;
  }>;
  /** Player role only. */
  me?: {
    participantId: string;
    nickname: string;
    score: number;
    rank: number;
    streak: number;
    canAnswer: boolean;
    submission?: { attemptId: string; optionIds: string[] };
    lastResult?: { correct: boolean; points: number; streak: number };
  };
  /** Host role only. */
  host?: {
    participants: Array<{
      id: string;
      nickname: string;
      score: number;
      rank: number;
      status: 'ACTIVE' | 'REMOVED';
      connected: boolean;
    }>;
    answered: number;
    eligible: number;
    displayKey: string;
  };
};
