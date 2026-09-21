import { afterAll, describe, expect, it } from 'vitest';
import type { QuizSnapshot } from '@ictquiz/shared';
import { prisma } from './setup.js';
import { ORIGIN, createOrganizer, loginCookie, seedQuiz, testApp, validDraft } from './helpers.js';

const app = await testApp();
afterAll(() => app.close());

const authed = (sid: string) => ({ ...ORIGIN, cookie: `sid=${sid}` });

describe('sessions', () => {
  it('POST /sessions on an invalid quiz → 400 with playIssues', async () => {
    await createOrganizer('s1@example.com');
    const cookies = await loginCookie(app, 's1@example.com', 'Password123!');
    const draft = validDraft();
    draft.questions[0]!.options = [{ text: 'only one', isCorrect: true }];
    const quizId = await seedQuiz(app, cookies, draft);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authed(cookies.sid),
      payload: { quizId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().playIssues.length).toBeGreaterThan(0);
  });

  it('POST /sessions on a valid quiz → pin, activePin, snapshot with isCorrect', async () => {
    const cookies = await loginCookie(app, 's1@example.com', 'Password123!');
    const quizId = await seedQuiz(app, cookies);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authed(cookies.sid),
      payload: { quizId },
    });
    expect(res.statusCode).toBe(201);
    const { id, pin, displayKey } = res.json();
    expect(pin).toMatch(/^\d{6}$/);
    expect(displayKey).toBeTruthy();

    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id } });
    expect(row.activePin).toBe(pin);
    expect(row.state).toBe('LOBBY');
    const snapshot = row.quizSnapshot as unknown as QuizSnapshot;
    expect(snapshot.questions).toHaveLength(3);
    expect(snapshot.questions[0]!.options.some((o) => o.isCorrect)).toBe(true);
    expect(snapshot.questions[1]!.options.map((o) => o.text)).toEqual(['True', 'False']);
    expect(snapshot.questions[0]!.index).toBe(0);
  });

  it('GET /sessions and /sessions/:id are organizer-scoped', async () => {
    const cookies = await loginCookie(app, 's1@example.com', 'Password123!');
    const list = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: authed(cookies.sid),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().sessions.length).toBeGreaterThan(0);
    expect(list.json().sessions[0]).toMatchObject({ state: 'LOBBY', participantCount: 0 });
    const id = list.json().sessions[0].id;
    const one = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}`,
      headers: authed(cookies.sid),
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().session.displayKey).toBeTruthy();

    // other organizer cannot see it
    await createOrganizer('s2@example.com');
    const other = await loginCookie(app, 's2@example.com', 'Password123!');
    const denied = await app.inject({
      method: 'GET',
      url: `/api/sessions/${id}`,
      headers: authed(other.sid),
    });
    expect(denied.statusCode).toBe(404);
  });
});

describe('join + health', () => {
  it('GET /api/join/:pin is public; 404 for unknown or malformed pins', async () => {
    const cookies = await loginCookie(app, 's1@example.com', 'Password123!');
    const quizId = await seedQuiz(app, cookies);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authed(cookies.sid),
      payload: { quizId },
    });
    const { id, pin } = created.json();

    const ok = await app.inject({ method: 'GET', url: `/api/join/${pin}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      sessionId: id,
      title: 'Event quiz',
      locked: false,
      state: 'LOBBY',
    });

    const missing = await app.inject({ method: 'GET', url: '/api/join/000000' });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({ method: 'GET', url: '/api/join/abc' });
    expect(malformed.statusCode).toBe(404);
  });

  it('GET /api/health → ok with db ping', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: { ok: true } });
  });

  it('GET /api/diagnostics requires auth and reports shape', async () => {
    const cookies = await loginCookie(app, 's1@example.com', 'Password123!');
    const denied = await app.inject({ method: 'GET', url: '/api/diagnostics' });
    expect(denied.statusCode).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url: '/api/diagnostics',
      headers: { cookie: `sid=${cookies.sid}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      db: { ok: true },
      sockets: { total: 0 },
      rooms: { active: 0 },
    });
    expect(Array.isArray(res.json().recentErrors)).toBe(true);
  });
});
