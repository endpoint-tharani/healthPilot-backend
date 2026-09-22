import { AccountingStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma';
import { AuthContext } from '../../context/authContext';
import { logger } from '../../loggers';
import {
  DocumentAccountingOutcome,
  markDocumentAccounting,
  markPaymentAccounting,
  postDocumentAccounting,
  postSupplierPaymentAccounting,
} from './accounting.service';

/**
 * The bridge between a business event and the books.
 *
 * Until now the pharmacy workflow and the accounting module met only at a seed
 * script and an explicit HTTP endpoint: documents were raised correctly, journals
 * existed, and nothing connected them. An invoice could be POSTED all day without
 * a payable ever reaching the balance sheet, and the only sign of it was a Trial
 * Balance that quietly disagreed with the document register.
 *
 * These two functions are what business services call, and they encode the whole
 * failure policy:
 *
 *   - The posting runs on the caller's transaction client, so the journal commits
 *     with the document or not at all. There is no window in which a supplier
 *     invoice exists and its payable does not.
 *
 *   - A company whose chart of accounts has never been initialised is the one
 *     case that does not fail the business operation. That is checked first, as a
 *     read, before anything is written: a tenant that has not been onboarded onto
 *     accounting can still run a pharmacy, and the document is marked PENDING with
 *     the reason so the gap is visible and retryable rather than lost. Discovering
 *     this by catching the error instead would not work - a failed statement
 *     aborts the surrounding Postgres transaction, and everything after it fails
 *     too.
 *
 *   - Every other failure - a missing mapping, an inactive ledger, a head with two
 *     ledgers and no default, an unbalanced journal - propagates and rolls the
 *     business transaction back. That is deliberate and it is the point of Phase
 *     10: a posted invoice with no accounting is worse than a refused invoice,
 *     because the first is wrong silently and the second is wrong loudly.
 */

/** True when the tenant has a chart of accounts to post into. */
async function accountingIsInitialised(
  tx: Prisma.TransactionClient,
  companyId: string
): Promise<boolean> {
  const company = await tx.company.findUnique({
    where: { id: companyId },
    select: { accountingTemplateKey: true },
  });
  return Boolean(company?.accountingTemplateKey);
}

const NOT_INITIALISED =
  'Accounting has not been initialised for this company, so no journal was raised. ' +
  'Initialise the chart of accounts, then retry accounting on this document.';

/**
 * Raises the accounting a document calls for, inside the transaction that created
 * it.
 *
 * Returns the outcome so a caller can log what was booked; returns null when the
 * tenant has no chart of accounts and the document was marked PENDING instead.
 */
export async function autoPostDocumentAccounting(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  documentId: string,
  documentType: DocumentType
): Promise<DocumentAccountingOutcome | null> {
  if (!(await accountingIsInitialised(tx, auth.companyId))) {
    await markDocumentAccounting(tx, documentId, AccountingStatus.PENDING, NOT_INITIALISED);
    logger.warn('Document raised without accounting: company not initialised', {
      companyId: auth.companyId,
      documentId,
      documentType,
    });
    return null;
  }

  const outcome = await postDocumentAccounting(auth, documentId, tx);

  logger.info('Accounting posted with the business document', {
    companyId: auth.companyId,
    document: outcome.documentNumber,
    documentType,
    journals: outcome.journals.map((j) => j.event + ' ' + j.journalNumber),
    skipped: outcome.skipped.map((s) => s.event),
  });

  return outcome;
}

/**
 * Raises the accounting for a supplier payment, inside the transaction that
 * created or allocated it.
 *
 * A payment with nothing allocated to a supplier invoice settles no liability and
 * is not an accounting event yet - it is money against nothing in particular. It
 * is left PENDING rather than booked, and the allocation that gives it a purpose
 * is what posts it.
 */
export async function autoPostPaymentAccounting(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  paymentId: string
): Promise<void> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      companyId: true,
      supplierId: true,
      paymentNumber: true,
      accountingStatus: true,
      allocations: {
        select: { document: { select: { documentType: true } } },
      },
    },
  });
  if (!payment || payment.companyId !== auth.companyId) {
    return;
  }

  // A patient receipt has no supplier. It is booked by the dispensing sale it
  // settles - booking it here as well would record the same cash twice.
  if (!payment.supplierId) {
    await markDocumentOrPaymentNotRequired(tx, payment.id);
    return;
  }

  const settlesAnInvoice = payment.allocations.some(
    (a) => a.document.documentType === DocumentType.SUPPLIER_INVOICE
  );
  if (!settlesAnInvoice) {
    await markPaymentAccounting(
      tx,
      payment.id,
      AccountingStatus.PENDING,
      'Not allocated to a supplier invoice yet, so no liability has been settled. ' +
        'Accounting is raised when the payment is allocated.'
    );
    return;
  }

  if (!(await accountingIsInitialised(tx, auth.companyId))) {
    await markPaymentAccounting(tx, payment.id, AccountingStatus.PENDING, NOT_INITIALISED);
    logger.warn('Payment raised without accounting: company not initialised', {
      companyId: auth.companyId,
      paymentId,
    });
    return;
  }

  const result = await postSupplierPaymentAccounting(auth, paymentId, tx);

  logger.info('Supplier payment accounting posted with the payment', {
    companyId: auth.companyId,
    payment: payment.paymentNumber,
    journalNumber: result.journalNumber,
    alreadyPosted: result.alreadyPosted,
  });
}

async function markDocumentOrPaymentNotRequired(
  tx: Prisma.TransactionClient,
  paymentId: string
): Promise<void> {
  await markPaymentAccounting(
    tx,
    paymentId,
    AccountingStatus.NOT_REQUIRED,
    'A patient receipt is booked by the dispensing sale it settles, not as a payment of its own.'
  );
}

/**
 * The recovery path behind the Retry accounting button.
 *
 * Runs on its own rather than inside a business transaction, so a failure has no
 * document to roll back - it is recorded on the document as FAILED, with the
 * reason the user needs to fix it, and the retry stays idempotent because the
 * posting itself is. This is the only way a FAILED row can come about.
 */
export async function retryDocumentAccounting(
  auth: AuthContext,
  documentId: string
): Promise<DocumentAccountingOutcome> {
  try {
    return await postDocumentAccounting(auth, documentId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordFailure('DOCUMENT', documentId, auth.companyId, reason);
    throw error;
  }
}

export async function retryPaymentAccounting(auth: AuthContext, paymentId: string) {
  try {
    return await postSupplierPaymentAccounting(auth, paymentId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordFailure('PAYMENT', paymentId, auth.companyId, reason);
    throw error;
  }
}

/**
 * Records why a posting did not succeed, without letting that record mask the
 * failure: the original error is still raised to the caller.
 *
 * Scoped by company on the write, so a failure reported against an id belonging
 * to another tenant cannot touch their row.
 */
async function recordFailure(
  kind: 'DOCUMENT' | 'PAYMENT',
  id: string,
  companyId: string,
  reason: string
): Promise<void> {
  try {
    if (kind === 'DOCUMENT') {
      await prisma.document.updateMany({
        where: { id, companyId },
        data: {
          accountingStatus: AccountingStatus.FAILED,
          accountingMessage: reason,
          accountingPostedAt: null,
        },
      });
    } else {
      await prisma.payment.updateMany({
        where: { id, companyId },
        data: {
          accountingStatus: AccountingStatus.FAILED,
          accountingMessage: reason,
          accountingPostedAt: null,
        },
      });
    }
  } catch (writeError) {
    // The posting error is what the caller needs to see; failing to record it is
    // a second problem, not a replacement for the first.
    logger.error('Could not record an accounting failure', {
      kind,
      id,
      reason,
      writeError: writeError instanceof Error ? writeError.message : String(writeError),
    });
  }
}
