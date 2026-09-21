import './env.js';
import { buildApp } from './app.js';
import { getConfig } from './env.js';

const config = getConfig();
const app = await buildApp({ logger: true });

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
