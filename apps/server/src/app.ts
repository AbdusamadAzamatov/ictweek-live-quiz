import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { hash as argonHash } from '@node-rs/argon2';
import { getConfig, type AppConfig } from './env.js';
import { createPrisma } from './lib/db.js';
import { recordError } from './lib/errors.js';
import type { PrismaClient } from './generated/prisma/client.js';
import type { OrganizerModel } from './generated/prisma/models.js';
import { authRoutes } from './routes/auth.js';
import { quizRoutes } from './routes/quizzes.js';
import { sessionRoutes } from './routes/sessions.js';
import { publicRoutes } from './routes/public.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    config: AppConfig;
  }
  interface FastifyRequest {
    organizerId?: string;
    organizer?: OrganizerModel;
  }
}

export type BuildAppOptions = {
  prisma?: PrismaClient;
  config?: Partial<AppConfig>;
  logger?: boolean;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config: AppConfig = { ...getConfig(), ...opts.config };
  const prisma = opts.prisma ?? createPrisma(config.databaseUrl);

  const app = fastify({
    logger: opts.logger ?? config.isProduction,
    trustProxy: process.env.TRUST_PROXY === '1',
  });
  app.decorate('prisma', prisma);
  app.decorate('config', config);

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    max: 1000,
    timeWindow: '1 minute',
    // specific routes tighten this (login 10/min, join 120/min)
  });
  await app.register(fastifyMultipart, { limits: { fileSize: 5 * 1024 * 1024 } });

  // /media/* — long-lived immutable assets (uploads land in Phase 3)
  const mediaRoot = path.resolve(config.mediaDir);
  fs.mkdirSync(mediaRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: mediaRoot,
    prefix: '/media/',
    decorateReply: false,
    index: false,
    list: false,
    cacheControl: true,
    maxAge: '365d',
    immutable: true,
  });

  const hasWebDist = fs.existsSync(path.join(webDist, 'index.html'));
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: webDist });
  }

  // CSRF guard: mutating /api/* requests must carry an allowed Origin.
  const allowedOrigins = new Set([config.publicOrigin]);
  if (!config.isProduction) allowedOrigins.add('http://localhost:5173');
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (!origin) {
      return reply.code(403).send({ error: 'Missing Origin header' });
    }
    let originHost: string;
    try {
      originHost = new URL(origin).origin;
    } catch {
      return reply.code(403).send({ error: 'Invalid Origin header' });
    }
    if (!allowedOrigins.has(originHost)) {
      return reply.code(403).send({ error: 'Origin not allowed' });
    }
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      recordError(err);
      req.log.error({ err }, 'request failed');
    }
    const issues = (err as { issues?: unknown }).issues;
    reply
      .code(status)
      .send(
        issues
          ? { error: err.message, issues }
          : { error: status >= 500 ? 'Internal Server Error' : err.message },
      );
  });

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0] ?? '';
    const isApi = pathname.startsWith('/api/') || pathname === '/api';
    const isMedia = pathname.startsWith('/media/');
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(pathname);
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (hasWebDist && req.method === 'GET' && !isApi && !isMedia && (wantsHtml || !hasExtension)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  // Bootstrap the first organizer from env when the table is empty.
  app.addHook('onReady', async () => {
    if (!config.initialOrganizerEmail || !config.initialOrganizerPassword) return;
    const count = await prisma.organizer.count();
    if (count > 0) return;
    const passwordHash = await argonHash(config.initialOrganizerPassword);
    await prisma.organizer.create({
      data: { email: config.initialOrganizerEmail.toLowerCase(), passwordHash },
    });
    app.log.info(
      { email: config.initialOrganizerEmail },
      'created initial organizer from environment',
    );
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(quizRoutes);
      await api.register(sessionRoutes);
      await api.register(publicRoutes);
    },
    { prefix: '/api' },
  );

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return app;
}
