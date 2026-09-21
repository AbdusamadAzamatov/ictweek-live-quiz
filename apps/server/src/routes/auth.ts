import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, SESSION_TTL_MS, hashToken, newSessionToken } from '../lib/session.js';
import { parse } from '../lib/validate.js';
import { requireOrganizer } from '../plugins/auth.js';

const LoginSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(10).max(1024),
});

export function organizerDto(o: {
  id: string;
  email: string;
  createdAt: Date;
  passwordChangedAt: Date | null;
}) {
  return {
    id: o.id,
    email: o.email,
    createdAt: o.createdAt,
    mustChangePassword: o.passwordChangedAt === null,
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(LoginSchema, req.body);
      const organizer = await app.prisma.organizer.findUnique({
        where: { email: body.email.toLowerCase() },
      });
      const valid =
        organizer !== null && (await argonVerify(organizer.passwordHash, body.password));
      if (!valid) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }
      const token = newSessionToken();
      await app.prisma.organizerSession.create({
        data: {
          id: hashToken(token),
          organizerId: organizer.id,
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        },
      });
      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: app.config.secureCookies,
        maxAge: SESSION_TTL_MS / 1000,
      });
      return { organizer: organizerDto(organizer) };
    },
  );

  app.post('/auth/logout', { preHandler: requireOrganizer }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      await app.prisma.organizerSession.deleteMany({ where: { id: hashToken(token) } });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: requireOrganizer }, async (req) => {
    return { organizer: organizerDto(req.organizer!) };
  });

  app.post(
    '/auth/change-password',
    {
      preHandler: requireOrganizer,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const body = parse(ChangePasswordSchema, req.body);
      const organizer = req.organizer!;
      if (!(await argonVerify(organizer.passwordHash, body.currentPassword))) {
        return reply.code(401).send({ error: 'Current password is incorrect' });
      }
      if (body.newPassword === body.currentPassword) {
        return reply
          .code(400)
          .send({ error: 'New password must differ from the current password' });
      }
      const passwordHash = await argonHash(body.newPassword);
      const currentSessionId = hashToken(req.cookies[SESSION_COOKIE] ?? '');
      await app.prisma.$transaction([
        app.prisma.organizer.update({
          where: { id: organizer.id },
          data: { passwordHash, passwordChangedAt: new Date() },
        }),
        // revoke every other session of this organizer
        app.prisma.organizerSession.deleteMany({
          where: { organizerId: organizer.id, id: { not: currentSessionId } },
        }),
      ]);
      return { ok: true };
    },
  );
}
