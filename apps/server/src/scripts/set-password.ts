// Set an organizer's password non-interactively (e.g. inside the container):
//   node dist/scripts/set-password.js <email> <newPassword>
// Updates the hash, marks the password as changed, and revokes every existing
// session of that organizer. Never prints the password.
import { hash as argonHash } from '@node-rs/argon2';
import '../env.js';
import { getConfig } from '../env.js';
import { createPrisma } from '../lib/db.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: set-password <email> <newPassword>');
  process.exit(1);
}
if (password.length < 10 || password.length > 1024) {
  console.error('password must be 10-1024 characters');
  process.exit(1);
}

const prisma = createPrisma(getConfig().databaseUrl);
const organizer = await prisma.organizer.findUnique({
  where: { email: email.toLowerCase() },
});
if (!organizer) {
  console.error(`organizer ${email} not found`);
  process.exit(1);
}
const passwordHash = await argonHash(password);
await prisma.$transaction([
  prisma.organizer.update({
    where: { id: organizer.id },
    data: { passwordHash, passwordChangedAt: new Date() },
  }),
  prisma.organizerSession.deleteMany({ where: { organizerId: organizer.id } }),
]);
console.log(`password updated for ${organizer.email}; all sessions revoked`);
await prisma.$disconnect();
