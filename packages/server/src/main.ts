import { createApp } from './app.js';
import { loadDotenv } from './config.js';

loadDotenv();

const app = createApp();
await app.start();
const url = await app.listen();
const providers = app.registry.listProviders().map((p) => `${p.id} (${p.models.length} models)`);
app.config.log(`imaginator server listening on ${url}`);
app.config.log(`data dir: ${app.config.dataDir}`);
app.config.log(app.config.auth ? 'auth: enabled (web password + API key for MCP/scripts)' : 'auth: disabled (open localhost tool; set AUTH_ENABLED=1 to require a login)');
app.config.log(`providers: ${providers.length ? providers.join(', ') : 'none'}; global concurrency ${app.config.globalConcurrency}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.config.log(`${signal} received; shutting down`);
  const timer = setTimeout(() => process.exit(1), 10_000);
  await app.stop();
  clearTimeout(timer);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
