import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ORIGIN, createOrganizer, loginCookie, seedQuiz, testApp, validDraft } from './helpers.js';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/lib/session.js';
import { prisma } from './setup.js';

async function organizerIdFor(sid: string): Promise<string> {
  const s = await prisma.organizerSession.findFirstOrThrow({
    where: { id: hashToken(sid) },
    select: { organizerId: true },
  });
  return s.organizerId;
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function multipart(file: { filename: string; contentType: string; data: Buffer }) {
  const boundary = '----ictquiztest' + randomUUID().replace(/-/g, '');
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `content-disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `content-type: ${file.contentType}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function authed() {
  const app = await testApp();
  apps.push(app);
  const org = await createOrganizer(`m-${randomUUID()}@example.com`, 'Password123!');
  const cookies = await loginCookie(app, org.email, 'Password123!');
  return { app, cookies };
}

describe('media upload', () => {
  it('accepts a png and serves it', async () => {
    const { app, cookies } = await authed();
    const { payload, contentType } = multipart({
      filename: 'dot.png',
      contentType: 'image/png',
      data: PNG_1PX,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: { ...ORIGIN, cookie: `sid=${cookies.sid}`, 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.url).toMatch(/^\/media\/.+\.png$/);
    expect(body.width).toBe(1);
    expect(body.height).toBe(1);

    const asset = await prisma.mediaAsset.findUnique({ where: { id: body.id } });
    expect(asset?.mimeType).toBe('image/png');
    const served = await app.inject({ method: 'GET', url: body.url });
    expect(served.statusCode).toBe(200);
  });

  it('rejects wrong magic bytes', async () => {
    const { app, cookies } = await authed();
    const { payload, contentType } = multipart({
      filename: 'evil.png',
      contentType: 'image/png',
      data: Buffer.from('this is definitely not a png'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: { ...ORIGIN, cookie: `sid=${cookies.sid}`, 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects oversize files', async () => {
    const app = await buildApp({ logger: false, config: { maxUploadMb: 0.0005 } });
    apps.push(app);
    const org = await createOrganizer(`o-${randomUUID()}@example.com`, 'Password123!');
    const cookies = await loginCookie(app, org.email, 'Password123!');
    const { payload, contentType } = multipart({
      filename: 'big.png',
      contentType: 'image/png',
      data: Buffer.concat([PNG_1PX, Buffer.alloc(2048)]),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/media',
      headers: { ...ORIGIN, cookie: `sid=${cookies.sid}`, 'content-type': contentType },
      payload,
    });
    expect([400, 413]).toContain(res.statusCode);
  });

  it('scopes PATCH altText to the owner', async () => {
    const { app, cookies } = await authed();
    const other = await createOrganizer(`other-${randomUUID()}@example.com`, 'Password123!');
    const asset = await prisma.mediaAsset.create({
      data: {
        organizerId: other.id,
        originalName: 'x.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        width: 1,
        height: 1,
        storagePath: 'x.png',
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/media/${asset.id}`,
      headers: { ...ORIGIN, cookie: `sid=${cookies.sid}` },
      payload: { altText: 'mine now' },
    });
    expect(res.statusCode).toBe(404);

    const own = await prisma.mediaAsset.create({
      data: {
        organizerId: await organizerIdFor(cookies.sid),
        originalName: 'y.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        width: 1,
        height: 1,
        storagePath: 'y.png',
      },
    });
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/media/${own.id}`,
      headers: { ...ORIGIN, cookie: `sid=${cookies.sid}` },
      payload: { altText: 'a dot' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().altText).toBe('a dot');
  });
});

describe('csv import', () => {
  const header =
    'type,question,option1,option2,option3,option4,option5,option6,correct,timeLimit,points,explanation';

  it('serves the template', async () => {
    const { app, cookies } = await authed();
    const res = await app.inject({
      method: 'GET',
      url: '/api/import-template.csv',
      headers: { cookie: `sid=${cookies.sid}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(header);
  });

  it('previews valid rows and row errors', async () => {
    const { app, cookies } = await authed();
    const quizId = await seedQuiz(app, cookies);
    const csv = `${header}\nsingle,New q?,a,b,,,,,2\nbogus,Bad row,x,y,,,,,1\nsingle,Q2 ok?,p,q,,,,,1,30,double,`;
    const { payload, contentType } = multipart({
      filename: 'q.csv',
      contentType: 'text/csv',
      data: Buffer.from(csv),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/quizzes/${quizId}/import-csv/preview`,
      headers: { ...ORIGIN, cookie: `sid=${cookies.sid}`, 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.questions).toHaveLength(2);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].row).toBe(3);
  });

  it('imports only the valid rows', async () => {
    const { app, cookies } = await authed();
    const quizId = await seedQuiz(app, cookies);
    const csv = `${header}\nsingle,Imported q?,a,b,,,,,1\nnope,Bad,x,y,,,,,1`;
    const { payload, contentType } = multipart({
      filename: 'q.csv',
      contentType: 'text/csv',
      data: Buffer.from(csv),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/quizzes/${quizId}/import-csv`,
      headers: { ...ORIGIN, cookie: `sid=${cookies.sid}`, 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.quiz.questions).toHaveLength(4); // 3 seeded + 1 imported
    expect(body.quiz.questions[3].text).toBe('Imported q?');
  });
});

describe('session media resolution', () => {
  it('freezes media urls into the snapshot', async () => {
    const { app, cookies } = await authed();
    const orgId = await organizerIdFor(cookies.sid);
    const asset = await prisma.mediaAsset.create({
      data: {
        organizerId: orgId,
        originalName: 'q.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        width: 10,
        height: 10,
        storagePath: 'q.png',
        altText: 'a question image',
      },
    });
    const draft = validDraft();
    (draft.questions[0] as { mediaId?: string }).mediaId = asset.id;
    const quizId = await seedQuiz(app, cookies, draft);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { ...ORIGIN, cookie: `sid=${cookies.sid}` },
      payload: { quizId, settings: {} },
    });
    expect(res.statusCode).toBe(201);
    const session = await prisma.gameSession.findUniqueOrThrow({
      where: { id: res.json().id },
    });
    const snap = session.quizSnapshot as {
      questions: Array<{ media: { url: string; alt: string } | null }>;
    };
    expect(snap.questions[0]!.media).toEqual({
      url: '/media/q.png',
      alt: 'a question image',
    });
    expect(snap.questions[1]!.media).toBeNull();
  });
});
