import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const nodeEnv = process.env.NODE_ENV || 'development';
const productionMode = nodeEnv === 'production';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is missing.`);
  }
  return value;
}

/** Secrets that were once hard-coded here, plus the obvious placeholders. */
const REJECTED_SECRETS = new Set([
  'change-me-secret',
  'changeme',
  'change-me',
  'secret',
  'jwt-secret',
  'your-secret-here',
  'replace-me',
]);

const PRODUCTION_SECRET_MIN_LENGTH = 32;
const DEVELOPMENT_SECRET_MIN_LENGTH = 16;

/**
 * The JWT signing secret. There is deliberately no fallback: a default would let
 * a deployment that forgot to set one sign tokens that anybody holding this
 * source could forge. A missing, placeholder or too-short value fails the
 * process at startup instead, and the value itself is never logged or echoed
 * back in the error.
 */
function requiredSigningSecret(name: string): string {
  const value = required(name).trim();

  if (REJECTED_SECRETS.has(value.toLowerCase())) {
    throw new Error(
      `${name} is set to a known placeholder value. Generate a unique secret, for example: ` +
        'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
    );
  }

  const minimum = productionMode ? PRODUCTION_SECRET_MIN_LENGTH : DEVELOPMENT_SECRET_MIN_LENGTH;
  if (value.length < minimum) {
    throw new Error(
      `${name} must be at least ${minimum} characters in ${nodeEnv}. ` +
        'The value is never printed; generate a longer one.'
    );
  }

  return value;
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv,
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: requiredSigningSecret('JWT_SECRET'),
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
  maxPageSize: parseInt(process.env.MAX_PAGE_SIZE || '100', 10),
  /** Public signup creates a whole tenant, so a deployment can close it off. */
  allowPublicSignup: (process.env.ALLOW_PUBLIC_SIGNUP || 'true').toLowerCase() !== 'false',
  /** Set when the API runs behind a reverse proxy, so req.ip is the real client. */
  trustProxy: (process.env.TRUST_PROXY || 'false').toLowerCase() === 'true',
  /** Well-formed signup requests allowed per client address per hour. */
  signupRateLimit: parseInt(process.env.SIGNUP_RATE_LIMIT || '10', 10),
  /** Well-formed login attempts allowed per client address per window. */
  loginRateLimit: parseInt(process.env.LOGIN_RATE_LIMIT || '30', 10),
  loginRateLimitWindowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || '900000', 10),
} as const;

export const isProduction = productionMode;
