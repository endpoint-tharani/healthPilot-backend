import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} environment variable is missing.`);
  }
  return value;
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET', 'change-me-secret'),
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
  maxPageSize: parseInt(process.env.MAX_PAGE_SIZE || '100', 10),
  /** Public signup creates a whole tenant, so a deployment can close it off. */
  allowPublicSignup: (process.env.ALLOW_PUBLIC_SIGNUP || 'true').toLowerCase() !== 'false',
  /** Set when the API runs behind a reverse proxy, so req.ip is the real client. */
  trustProxy: (process.env.TRUST_PROXY || 'false').toLowerCase() === 'true',
  /** Well-formed signup requests allowed per client address per hour. */
  signupRateLimit: parseInt(process.env.SIGNUP_RATE_LIMIT || '10', 10),
} as const;

export const isProduction = config.nodeEnv === 'production';
