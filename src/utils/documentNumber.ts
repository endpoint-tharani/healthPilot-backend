import { DocumentType, Prisma } from '@prisma/client';
import {
  DOCUMENT_NUMBER_PREFIX,
  DOCUMENT_SEQUENCE_WIDTH,
  PAYMENT_NUMBER_PREFIX,
} from '../constants/documents';

function format(prefix: string, sequence: number): string {
  return prefix + '-' + String(sequence).padStart(DOCUMENT_SEQUENCE_WIDTH, '0');
}

/**
 * Serialises numbering per company and series with a transaction-scoped advisory
 * lock, so concurrent requests cannot mint the same number. The lock is released
 * automatically when the surrounding transaction ends.
 */
async function nextSequence(
  tx: Prisma.TransactionClient,
  companyId: string,
  series: string,
  currentMax: () => Promise<string | null>
): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${companyId + ':' + series}))`;

  const latest = await currentMax();
  if (!latest) {
    return 1;
  }
  const parsed = parseInt(latest.split('-').pop() ?? '0', 10);
  return Number.isNaN(parsed) ? 1 : parsed + 1;
}

export async function generateDocumentNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
  documentType: DocumentType
): Promise<string> {
  const sequence = await nextSequence(tx, companyId, documentType, async () => {
    const last = await tx.document.findFirst({
      where: { companyId, documentType },
      orderBy: { documentNumber: 'desc' },
      select: { documentNumber: true },
    });
    return last?.documentNumber ?? null;
  });
  return format(DOCUMENT_NUMBER_PREFIX[documentType], sequence);
}

export async function generatePaymentNumber(
  tx: Prisma.TransactionClient,
  companyId: string
): Promise<string> {
  const sequence = await nextSequence(tx, companyId, PAYMENT_NUMBER_PREFIX, async () => {
    const last = await tx.payment.findFirst({
      where: { companyId },
      orderBy: { paymentNumber: 'desc' },
      select: { paymentNumber: true },
    });
    return last?.paymentNumber ?? null;
  });
  return format(PAYMENT_NUMBER_PREFIX, sequence);
}
