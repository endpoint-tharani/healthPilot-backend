/**
 * Stable, machine-readable reasons for a 401. The message is prose for humans and
 * may be reworded at any time; this code is the contract a client interceptor
 * branches on. Only TOKEN_EXPIRED means "silently refresh and retry" - every other
 * code means the session is finished and the user must sign in again, which is what
 * stops an interceptor from looping on /auth/refresh for a deactivated account.
 */
export type AuthErrorCode =
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'TOKEN_MISSING'
  | 'SESSION_INVALID'
  | 'REFRESH_TOKEN_INVALID'
  | 'REFRESH_TOKEN_EXPIRED'
  | 'REFRESH_TOKEN_REVOKED'
  | 'ACCOUNT_INACTIVE';

export class AppError extends Error {
  readonly status: number;
  readonly details?: unknown;
  readonly code?: string;

  constructor(status: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, message, details);
export const unauthorized = (message = 'Unauthenticated', code: AuthErrorCode = 'TOKEN_INVALID') =>
  new AppError(401, message, undefined, code);
export const forbidden = (message = 'Access denied') => new AppError(403, message);
export const notFound = (message = 'Resource not found') => new AppError(404, message);
export const conflict = (message: string) => new AppError(409, message);
