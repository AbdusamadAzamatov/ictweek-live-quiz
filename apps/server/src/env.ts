import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// apps/server/src (or dist) -> apps/server/.env, then repo-root .env.
// dotenv never overrides already-set vars, so nearer files win.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../.env'), quiet: true });
dotenv.config({ path: path.resolve(here, '../../../.env'), quiet: true });

export type AppConfig = {
  port: number;
  databaseUrl: string;
  publicUrl: string;
  publicOrigin: string;
  sessionSecret: string;
  mediaDir: string;
  secureCookies: boolean;
  isProduction: boolean;
  initialOrganizerEmail: string | undefined;
  initialOrganizerPassword: string | undefined;
  /** COUNTDOWN phase length; overridable in tests. */
  countdownMs: number;
  /** Max image upload size, megabytes. */
  maxUploadMb: number;
  /** Trust X-Forwarded-For for client IPs (Caddy). */
  trustProxy: boolean;
  /** Shared join/PIN limiter budgets (DESIGN §7). */
  joinFailPerMin: number;
  joinFailPerHour: number;
  joinSuccessPerMin: number;
  /** Failure sliding-window override; tests only. */
  joinFailWindowMs?: number;
};

export function getConfig(): AppConfig {
  const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:5173';
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/ictquiz',
    publicUrl,
    publicOrigin: new URL(publicUrl).origin,
    sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret',
    mediaDir: process.env.MEDIA_DIR ?? './media',
    secureCookies: publicUrl.startsWith('https:'),
    isProduction: process.env.NODE_ENV === 'production',
    initialOrganizerEmail: process.env.INITIAL_ORGANIZER_EMAIL,
    initialOrganizerPassword: process.env.INITIAL_ORGANIZER_PASSWORD,
    countdownMs: Number(process.env.COUNTDOWN_MS ?? 5000),
    maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 5),
    trustProxy: process.env.TRUST_PROXY === '1',
    joinFailPerMin: Number(process.env.JOIN_FAIL_PER_MIN ?? 120),
    joinFailPerHour: Number(process.env.JOIN_FAIL_PER_HOUR ?? 1000),
    joinSuccessPerMin: Number(process.env.JOIN_SUCCESS_PER_MIN ?? 1200),
    joinFailWindowMs: process.env.JOIN_FAIL_WINDOW_MS
      ? Number(process.env.JOIN_FAIL_WINDOW_MS)
      : undefined,
  };
}
