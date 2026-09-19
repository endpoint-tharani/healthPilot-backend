import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../loggers';

export const prisma = new PrismaClient();

/** Any Prisma client: the root client or a client bound to an open transaction. */
export type Database = PrismaClient | Prisma.TransactionClient;

/**
 * ERP postings touch a document, its lines, several stock movements, links and
 * audit entries in one transaction. Over a network database the 5s Prisma default
 * is too tight, so business transactions use an explicit, generous budget.
 */
const TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

/** Connections opened up front. Keep at or below the pool's connection_limit. */
const DEFAULT_POOL_WARMUP = 5;

export function transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, TRANSACTION_OPTIONS);
}

export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error('Database connection failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Prisma opens pool connections lazily, and a fresh TLS handshake to a serverless
 * Postgres costs seconds. Without this the first few requests after startup each
 * pay for opening their own connection; issuing the trivial queries concurrently
 * forces the pool open before any of them arrives.
 */
export async function warmConnectionPool(size = DEFAULT_POOL_WARMUP): Promise<void> {
  try {
    await Promise.all(
      Array.from({ length: size }, () => prisma.$queryRaw`SELECT 1`)
    );
  } catch (error) {
    // A cold pool is slow, never wrong: the request path opens what it needs.
    logger.warn('Connection pool warmup did not complete', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
