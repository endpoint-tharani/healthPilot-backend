import { UserRole } from '@prisma/client';
import { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../utils/errors';

export function authorizeRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(unauthorized());
    }
    if (!allowedRoles.includes(req.auth.role)) {
      return next(forbidden('Insufficient role'));
    }
    next();
  };
}
