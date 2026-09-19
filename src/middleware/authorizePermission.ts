import { NextFunction, Request, Response } from 'express';
import { PermissionValue } from '../constants/permissions';
import { forbidden, unauthorized } from '../utils/errors';

export function authorizePermission(...required: PermissionValue[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(unauthorized());
    }
    const missing = required.filter((permission) => !req.auth!.permissions.includes(permission));
    if (missing.length > 0) {
      return next(forbidden('Missing permission: ' + missing.join(', ')));
    }
    next();
  };
}
