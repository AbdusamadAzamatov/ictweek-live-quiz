import { hash as argonHash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from './setup.js';

export const ORIGIN = { origin: 'http://localhost:5173' };

export async function testApp(): Promise<FastifyInstance> {
  return buildApp({ logger: false });
}

export async function createOrganizer(
  email = 'org@example.com',
  password = 'Password123!',
): Promise<{ id: string; email: string }> {
  const o = await prisma.organizer.create({
    data: { email: email.toLowerCase(), passwordHash: await argonHash(password) },
  });
  return { id: o.id, email: o.email };
}

export async function loginCookie(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<Record<string, string>> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: ORIGIN,
    payload: { email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  }
  const sid = res.cookies.find((c) => c.name === 'sid');
  if (!sid) throw new Error('no sid cookie');
  return { sid: sid.value };
}

export function validDraft() {
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
        options: [
          { text: '4', isCorrect: true },
          { text: '5', isCorrect: false },
        ],
      },
      {
        type: 'TRUE_FALSE',
        text: 'The sky is blue',
        timeLimitSec: 10,
        pointsMode: 'NONE',
        explanation: '',
        options: [
          { text: 'True', isCorrect: true },
          { text: 'False', isCorrect: false },
        ],
      },
      {
        type: 'MULTI',
        text: 'Pick the vowels',
        timeLimitSec: 30,
        pointsMode: 'DOUBLE',
        explanation: '',
        options: [
          { text: 'a', isCorrect: true },
          { text: 'e', isCorrect: true },
          { text: 'b', isCorrect: false },
          { text: 'c', isCorrect: false },
        ],
      },
    ],
  };
}

export async function seedQuiz(
  app: FastifyInstance,
  cookies: Record<string, string>,
  draft = validDraft(),
): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/quizzes',
    headers: { ...ORIGIN, cookie: `sid=${cookies.sid}` },
  });
  const quizId = created.json().quiz.id as string;
  const res = await app.inject({
    method: 'PUT',
    url: `/api/quizzes/${quizId}`,
    headers: { ...ORIGIN, cookie: `sid=${cookies.sid}` },
    payload: draft,
  });
  if (res.statusCode !== 200) throw new Error(`put quiz failed: ${res.body}`);
  return quizId;
}
