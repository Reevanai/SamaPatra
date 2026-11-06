import { buildApp } from './app.js';
import { pool } from './db/index.js';

const server = await buildApp();

// Graceful shutdown
const shutdown = async () => {
  server.log.info('Shutting down gracefully...');
  await server.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';

    await server.listen({ port, host });
    server.log.info(`Server listening on ${host}:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
