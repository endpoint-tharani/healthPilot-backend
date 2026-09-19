import { isProduction } from '../config/env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configuredLevel = (process.env.LOG_LEVEL as LogLevel) || (isProduction ? 'info' : 'debug');
const threshold = LEVEL_ORDER[configuredLevel] ?? LEVEL_ORDER.info;

const REDACTED_KEYS = [
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'secret',
];

/** Credentials and tokens must never reach a log sink, however they are nested. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, val]) => [
      key,
      REDACTED_KEYS.includes(key.toLowerCase()) ? '[redacted]' : redact(val, depth + 1),
    ])
  );
}

function write(level: LogLevel, message: string, meta?: unknown) {
  if (LEVEL_ORDER[level] < threshold) {
    return;
  }

  const time = new Date().toISOString();
  const payload = meta === undefined ? undefined : redact(meta);

  const line = isProduction
    ? JSON.stringify({ level, time, message, ...(payload === undefined ? {} : { meta: payload }) })
    : '[' + time + '] ' + level.toUpperCase() + ' ' + message +
      (payload === undefined ? '' : ' ' + JSON.stringify(payload));

  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};
