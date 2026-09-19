import { Notification, Prisma } from '@prisma/client';
import { transaction } from '../database/prisma';

/**
 * Transactional outbox for realtime delivery.
 *
 * Notification rows are written inside the business transaction, so they commit
 * or roll back with it and a failed operation can never leave an alert behind.
 * The socket event, however, must not leave the process until that commit has
 * actually happened - otherwise a rolled-back approval would still have told
 * somebody it was approved.
 *
 * Rows created during a transaction are parked here against the transaction
 * client itself, which lets any depth of nested service code enqueue without
 * threading a collector through its signature, and are only handed to the
 * gateway once `notifyingTransaction` has seen the transaction resolve.
 */
const pending = new WeakMap<object, Notification[]>();

export function enqueueNotifications(
  tx: Prisma.TransactionClient,
  rows: Notification[]
): void {
  if (rows.length === 0) {
    return;
  }
  const existing = pending.get(tx);
  if (existing) {
    existing.push(...rows);
  } else {
    pending.set(tx, [...rows]);
  }
}

export function drainNotifications(tx: Prisma.TransactionClient): Notification[] {
  const rows = pending.get(tx) ?? [];
  pending.delete(tx);
  return rows;
}

/**
 * Runs a business transaction and releases its notifications afterwards.
 *
 * `deliver` is invoked only after `transaction` has resolved, which is the point
 * at which Prisma has committed. A throw anywhere in `fn` rolls the notification
 * rows back with the rest of the work and nothing is ever emitted.
 */
export async function notifyingTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  deliver: (rows: Notification[]) => void
): Promise<T> {
  let created: Notification[] = [];

  const result = await transaction(async (tx) => {
    const value = await fn(tx);
    created = drainNotifications(tx);
    return value;
  });

  deliver(created);
  return result;
}
