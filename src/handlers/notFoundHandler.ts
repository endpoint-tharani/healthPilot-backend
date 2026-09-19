import { Request, Response } from 'express';
import { fail } from './response';

export function notFoundHandler(_req: Request, res: Response) {
  return fail(res, 404, 'Endpoint not found');
}
