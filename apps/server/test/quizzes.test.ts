import { afterAll, describe, expect, it } from 'vitest';
import { ORIGIN, createOrganizer, loginCookie, seedQuiz, testApp, validDraft } from './helpers.js';

const app = await testApp();
afterAll(() => app.close());

const authed = (sid: string) => ({ ...ORIGIN, cookie: `sid=${sid}` });

describe('quiz library', () => {
  it('CRUD round trip', async () => {
    await createOrganizer('crud@example.com');
    const cookies = await loginCookie(app, 'crud@example.com', 'Password123!');

    const created = await app.inject({
      method: 'POST',
      url: '/api/quizzes',
      headers: authed(cookies.sid),
    });
    expect(created.statusCode).toBe(201);
    const quizId = created.json().quiz.id;

    const put = await app.inject({
      method: 'PUT',
      url: `/api/quizzes/${quizId}`,
      headers: authed(cookies.sid),
      payload: validDraft(),
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().playIssues).toEqual([]);
    expect(put.json().quiz.questions).toHaveLength(3);
    // options persisted with isCorrect
    expect(put.json().quiz.questions[0].options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: '4', isCorrect: true }),
        expect.objectContaining({ text: '5', isCorrect: false }),
      ]),
    );

    const list = await app.inject({
      method: 'GET',
      url: '/api/quizzes',
      headers: authed(cookies.sid),
    });
    expect(list.json().quizzes).toEqual([
      expect.objectContaining({ id: quizId, questionCount: 3, title: 'Event quiz' }),
    ]);

    const got = await app.inject({
      method: 'GET',
      url: `/api/quizzes/${quizId}`,
      headers: authed(cookies.sid),
    });
    expect(
      got.json().quiz.questions[2].options.filter((o: { isCorrect: boolean }) => o.isCorrect),
    ).toHaveLength(2);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/quizzes/${quizId}`,
      headers: authed(cookies.sid),
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/quizzes/${quizId}`,
      headers: authed(cookies.sid),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('organizer B cannot read/put/delete organizer A quiz (404)', async () => {
    await createOrganizer('a2@example.com');
    await createOrganizer('b2@example.com');
    const a = await loginCookie(app, 'a2@example.com', 'Password123!');
    const b = await loginCookie(app, 'b2@example.com', 'Password123!');
    const quizId = await seedQuiz(app, a);

    for (const [method, url, payload] of [
      ['GET', `/api/quizzes/${quizId}`, undefined],
      ['PUT', `/api/quizzes/${quizId}`, validDraft()],
      ['DELETE', `/api/quizzes/${quizId}`, undefined],
      ['GET', `/api/quizzes/${quizId}/export`, undefined],
      ['POST', `/api/quizzes/${quizId}/duplicate`, undefined],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: authed(b.sid),
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('duplicate produces a copy with new ids', async () => {
    await createOrganizer('dup@example.com');
    const cookies = await loginCookie(app, 'dup@example.com', 'Password123!');
    const quizId = await seedQuiz(app, cookies);
    const res = await app.inject({
      method: 'POST',
      url: `/api/quizzes/${quizId}/duplicate`,
      headers: authed(cookies.sid),
    });
    expect(res.statusCode).toBe(201);
    const copy = res.json().quiz;
    expect(copy.id).not.toBe(quizId);
    expect(copy.title).toBe('Event quiz (copy)');
    expect(copy.questions).toHaveLength(3);
    expect(copy.questions[0].id).not.toBeUndefined();
  });

  it('export → import produces an equal quiz with new ids', async () => {
    await createOrganizer('io@example.com');
    const cookies = await loginCookie(app, 'io@example.com', 'Password123!');
    const quizId = await seedQuiz(app, cookies);

    const exp = await app.inject({
      method: 'GET',
      url: `/api/quizzes/${quizId}/export`,
      headers: authed(cookies.sid),
    });
    expect(exp.statusCode).toBe(200);
    const exported = exp.json();
    expect(exported.format).toBe('ictquiz-v1');

    const imp = await app.inject({
      method: 'POST',
      url: '/api/quizzes/import',
      headers: authed(cookies.sid),
      payload: exported,
    });
    expect(imp.statusCode).toBe(201);
    const imported = imp.json().quiz;
    expect(imported.id).not.toBe(quizId);

    const strip = (q: { questions: Array<Record<string, unknown>> } & Record<string, unknown>) => ({
      title: q.title,
      description: q.description,
      questions: q.questions.map((qq) => ({
        type: qq.type,
        text: qq.text,
        timeLimitSec: qq.timeLimitSec,
        pointsMode: qq.pointsMode,
        explanation: qq.explanation,
        options: (qq.options as Array<Record<string, unknown>>).map((o) => ({
          text: o.text,
          isCorrect: o.isCorrect,
        })),
      })),
    });
    const orig = await app.inject({
      method: 'GET',
      url: `/api/quizzes/${quizId}`,
      headers: authed(cookies.sid),
    });
    expect(strip(imported)).toEqual(strip(orig.json().quiz));
    expect(imported.questions[0].options[0].id).not.toBe(
      orig.json().quiz.questions[0].options[0].id,
    );
  });

  it('unauthenticated requests → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quizzes', headers: ORIGIN });
    expect(res.statusCode).toBe(401);
  });
});
