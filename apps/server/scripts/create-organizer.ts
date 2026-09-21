import { hash as argonHash } from '@node-rs/argon2';
import '../src/env.js';
import { getConfig } from '../src/env.js';
import { createPrisma } from '../src/lib/db.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: create-organizer <email> <password>');
  process.exit(1);
}
if (password.length < 10) {
  console.error('password must be at least 10 characters');
  process.exit(1);
}

const prisma = createPrisma(getConfig().databaseUrl);
const passwordHash = await argonHash(password);
const organizer = await prisma.organizer.upsert({
  where: { email: email.toLowerCase() },
  create: { email: email.toLowerCase(), passwordHash },
  update: { passwordHash },
});
console.log(`organizer ${organizer.email} ${organizer.createdAt ? 'saved' : 'created'}`);
await prisma.$disconnect();
