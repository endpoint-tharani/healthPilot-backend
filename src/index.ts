import express, { Express, Request, Response } from 'express';
import cors from 'cors';

import { config } from './config/env';
import { apiRouter } from './routes';
import { errorHandler } from './handlers/errorHandler';
import { notFoundHandler } from './handlers/notFoundHandler';

export const app: Express = express();

// The signup throttle keys on req.ip, which is only the real client once Express
// is told how many proxies sit in front of it.
if (config.trustProxy) {
  app.set('trust proxy', 1);
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'HealthPilot Pharmacy ERP API is running',
  });
});

app.use('/api', apiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
