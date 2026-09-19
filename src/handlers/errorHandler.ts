import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors';
import { logger } from '../loggers';
import { fail } from './response';

/**
 * Single exit point for errors. Prisma and runtime failures are logged server-side
 * and answered with a generic 500: no SQL, stack trace or internal detail leaves
 * the process.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return fail(res, err.status, err.message, err.details);
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return fail(res, 409, 'Record already exists');
    }
    if (err.code === 'P2025') {
      return fail(res, 404, 'Resource not found');
    }
  }

  logger.error('Unhandled request error', {
    method: req.method,
    path: req.path,
    reason: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  return fail(res, 500, 'Internal server error');
}
