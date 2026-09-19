import { NextFunction, Request, Response } from 'express';
import { fail } from '../handlers/response';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window, in-process throttle. It exists to blunt scripted abuse of the
 * public signup endpoint; it is per-process and therefore advisory only, so a
 * multi-instance deployment should still sit behind a shared limiter or WAF.
 */
export function rateLimit(options: { windowMs: number; max: number; message: string }) {
  const windows = new Map<string, Window>();

  return (req: Request, res: Response, next: NextFunction) => {
    if (options.max <= 0) {
      return next();
    }

    const now = Date.now();
    const key = req.ip ?? 'unknown';

    // Sweep expired windows so an attacker cycling addresses cannot grow the map
    // without bound.
    if (windows.size > 10_000) {
      for (const [entryKey, entry] of windows) {
        if (entry.resetAt <= now) {
          windows.delete(entryKey);
        }
      }
    }

    const current = windows.get(key);
    if (!current || current.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (current.count >= options.max) {
      res.setHeader('Retry-After', Math.ceil((current.resetAt - now) / 1000));
      return fail(res, 429, options.message);
    }

    current.count += 1;
    return next();
  };
}
