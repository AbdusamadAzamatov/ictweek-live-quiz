import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, hashToken } from '../lib/session.js';

/**
 * preHandler: requires a valid organizer session cookie.
 * On success sets request.organizer / request.organizerId.
 */
export async function requireOrganizer(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) {
    return reply.code(401).send({ error: 'Authentication required' });
  }
  const session = await req.server.prisma.organizerSession.findUnique({
    where: { id: hashToken(token) },
    include: { organizer: true },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    return reply.code(401).send({ error: 'Authentication required' });
  }
  req.organizerId = session.organizerId;
  req.organizer = session.organizer;
}
