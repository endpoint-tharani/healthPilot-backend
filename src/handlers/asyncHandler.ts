import { NextFunction, Request, RequestHandler, Response } from 'express';

type ControllerFn = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Forwards rejected promises to the error handler, keeping controllers try/catch free. */
export function asyncHandler(fn: ControllerFn): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}
