import jwt, { SignOptions, TokenExpiredError } from 'jsonwebtoken';
import { config } from '../config/env';
import { unauthorized } from './errors';

export interface AccessTokenClaims {
  sub: string;
  companyId: string;
  role: string;
  tokenType: 'access';
  iat?: number;
  exp?: number;
}

export function signAccessToken(userId: string, companyId: string, role: string): string {
  const claims: Omit<AccessTokenClaims, 'iat' | 'exp'> = {
    sub: userId,
    companyId,
    role,
    tokenType: 'access',
  };
  const options = { expiresIn: config.accessTokenExpiresIn } as SignOptions;
  return jwt.sign(claims, config.jwtSecret, options);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    // Expiry is the one failure a client can recover from on its own, so it is
    // reported apart from a malformed or forged token: the first says "rotate at
    // /auth/refresh and retry", the second says "sign in again".
    if (err instanceof TokenExpiredError) {
      throw unauthorized('Access token has expired', 'TOKEN_EXPIRED');
    }
    throw unauthorized('Invalid access token', 'TOKEN_INVALID');
  }

  const claims = decoded as AccessTokenClaims;
  if (!claims || claims.tokenType !== 'access' || !claims.sub || !claims.companyId) {
    throw unauthorized('Invalid access token', 'TOKEN_INVALID');
  }
  return claims;
}
