// Prepares the e2e database before the production server boots.
// Playwright launches webServer before globalSetup, and the app exits if the
// schema is missing — so create + migrate + truncate must happen here.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const E2E_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/ictquiz_e2e';

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

const url = new URL(E2E_URL);
const dbName = url.pathname.replace(/^\//, '');
const adminUrl = new URL(E2E_URL);
adminUrl.pathname = '/postgres';

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
  dbName,
]);
if (rowCount === 0) {
  await admin.query(`CREATE DATABASE "${dbName}"`);
  console.log(`[e2e] created database ${dbName}`);
}
await admin.end();

// Same path as the production entrypoint: prisma migrate deploy.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrated = spawnSync('pnpm --filter @ictquiz/server exec prisma migrate deploy', {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_URL: E2E_URL },
  shell: true,
  stdio: 'inherit',
});
if (migrated.status !== 0) {
  throw new Error(`[e2e] prisma migrate deploy failed (exit ${migrated.status})`);
}

// Clean slate for every run.
const db = new pg.Client({ connectionString: E2E_URL });
await db.connect();
await db.query(
  `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
);
await db.end();
console.log('[e2e] database ready (migrated + truncated)');
