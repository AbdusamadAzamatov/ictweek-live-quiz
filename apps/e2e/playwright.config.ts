import { defineConfig, devices } from '@playwright/test';

const e2eDb =
  process.env.E2E_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/ictquiz_e2e';

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  // Always the production build: Fastify serves apps/web/dist and /api on :3100.
  // prepare-db.mjs creates + migrates + truncates the e2e database first —
  // the app exits if the schema is missing at boot.
  webServer: {
    command: 'node ./prepare-db.mjs && node ../server/dist/index.js',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      PORT: '3100',
      PUBLIC_URL: 'http://localhost:3100',
      DATABASE_URL: e2eDb,
      MEDIA_DIR: './media-e2e',
      COUNTDOWN_MS: '1500',
      INITIAL_ORGANIZER_EMAIL: 'e2e@example.com',
      INITIAL_ORGANIZER_PASSWORD: 'E2ePassword123!',
    },
  },
});
