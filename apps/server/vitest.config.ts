import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env'), quiet: true });
dotenv.config({ path: path.resolve(here, '.env'), quiet: true });

export default defineConfig({
  resolve: {
    alias: {
      '@ictquiz/shared': path.resolve(here, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globalSetup: './test/globalSetup.ts',
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL_TEST ?? '',
      PUBLIC_URL: 'http://localhost:5173',
      SESSION_SECRET: 'test-secret',
      MEDIA_DIR: './media-test',
      PORT: '0',
    },
  },
});
