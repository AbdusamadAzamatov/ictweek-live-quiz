import { afterAll, beforeAll } from 'vitest';
import { createPrisma } from '../src/lib/db.js';

export const prisma = createPrisma(process.env.DATABASE_URL!);

const TABLES = [
  'SessionEvent',
  'Submission',
  'QuestionAttempt',
  'Participant',
  'GameSession',
  'AnswerOption',
  'Question',
  'Quiz',
  'MediaAsset',
  'OrganizerSession',
  'Organizer',
];

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
