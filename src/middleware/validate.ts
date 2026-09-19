import { NextFunction, Request, Response } from 'express';
import { ZodType } from 'zod';
import { fail } from '../handlers/response';

interface ZodIssueLike {
  path: PropertyKey[];
  message: string;
}

function respond(res: Response, error: { issues: ZodIssueLike[] }) {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    (errors[key] ??= []).push(issue.message);
  }
  return fail(res, 400, 'Validation error', errors);
}

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return respond(res, result.error);
    }
    req.body = result.data;
    next();
  };
}

/** Express 5 exposes req.query as a getter, so parsed values live on req.validatedQuery. */
export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return respond(res, result.error);
    }
    req.validatedQuery = result.data;
    next();
  };
}

export function validateParams<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return respond(res, result.error);
    }
    req.validatedParams = result.data;
    next();
  };
}

export function query<T>(req: Request): T {
  return req.validatedQuery as T;
}

export function params<T>(req: Request): T {
  return req.validatedParams as T;
}
