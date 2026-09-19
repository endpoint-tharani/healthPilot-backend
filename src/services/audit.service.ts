import { Prisma } from '@prisma/client';
import { AuditAction, AuditActionValue } from '../constants/audit';

export { AuditAction };
export type { AuditActionValue };

export interface AuditInput {
  companyId: string;
  documentId: string;
  userId: string;
  action: AuditActionValue;
  reason?: string | null;
  oldData?: unknown;
  newData?: unknown;
}

/**
 * Appends to DocumentLog. `changes` holds a before/after snapshot; credentials
 * and tokens are never passed in by callers and never serialised here.
 */
export async function logDocumentAction(tx: Prisma.TransactionClient, input: AuditInput) {
  const changes =
    input.oldData === undefined && input.newData === undefined
      ? null
      : JSON.stringify({ old: input.oldData ?? null, new: input.newData ?? null });

  await tx.documentLog.create({
    data: {
      companyId: input.companyId,
      documentId: input.documentId,
      userId: input.userId,
      action: input.action,
      reason: input.reason ?? null,
      changes,
    },
  });
}
