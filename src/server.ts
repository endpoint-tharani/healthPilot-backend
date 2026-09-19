import { createServer } from 'http';
import { app } from './index';
import { config } from './config/env';
import { checkDatabaseConnection, disconnectDatabase, warmConnectionPool } from './database/prisma';
import { closeSocketServer, initSocketServer } from './realtime/socketServer';
import { logger } from './loggers';

async function startServer() {
  if (!(await checkDatabaseConnection())) {
    logger.error('Cannot connect to PostgreSQL. Server startup aborted.');
    process.exit(1);
  }

  await warmConnectionPool();

  // The realtime gateway shares this HTTP server: one process, one port, and the
  // same origin the REST API is served from.
  const server = createServer(app);
  initSocketServer(server);

  server.listen(config.port, () => {
    logger.info('Server listening', { port: config.port, env: config.nodeEnv });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info('Shutting down', { signal });
      void closeSocketServer().finally(() => {
        server.close(() => {
          void disconnectDatabase().finally(() => process.exit(0));
        });
      });
    });
  }
}

void startServer();
