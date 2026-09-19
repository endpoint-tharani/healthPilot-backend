import { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../utils/errors';
import { setAuthContext } from '../context/authContext';
import { authContextFromAccessToken } from '../context/resolveIdentity';

/**
 * Verifies the bearer access token and rebuilds the request identity from the
 * database, so revoked or deactivated users cannot keep using a live token and no
 * client-supplied companyId or branchId ever reaches an authorization decision.
 */
export async function authenticateUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized('Missing or malformed Authorization header');
    }

    setAuthContext(req, await authContextFromAccessToken(header.slice('Bearer '.length).trim()));
    next();
  } catch (err) {
    next(err);
  }
}
