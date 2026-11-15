import { createPool, initializeDatabase } from './db.mjs';
import { cleanupStaleUploads, createApp } from './app.mjs';
import { fileURLToPath } from 'node:url';

const pool = createPool();
const port = Number(process.env.PORT ?? 3000);

try {
  await initializeDatabase(pool);
  const app = createApp({ pool });
  const dataDir = process.env.DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url));
  await cleanupStaleUploads(dataDir);
  const cleanupTimer = setInterval(() => cleanupStaleUploads(dataDir).catch(error => console.error('Upload cleanup failed:', error)), 60 * 60 * 1000);
  cleanupTimer.unref();
  const server = app.listen(port, '0.0.0.0', () => console.log(`DemoCenter listening on port ${port}`));
  const shutdown = () => { clearInterval(cleanupTimer); server.close(() => pool.end()); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error('DemoCenter could not start:', error);
  await pool.end();
  process.exitCode = 1;
}
