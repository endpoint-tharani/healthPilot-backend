import { DocumentLinkType, DocumentStatus, Prisma } from '@prisma/client';
import { Database } from '../database/prisma';
import { money, ZERO } from '../utils/decimal';

/**
 * What a supplier invoice is worth, from every angle that matters.
 *
 * Lives in a module of its own rather than in `supplierInvoice.service`, where it
 * used to, because accounting now posts inside the business transaction: the
 * invoice service calls the accounting service, and the accounting service needs
 * this to work out what to book. Left where it was, those two modules would
 * import each other, and a require cycle that happens to work under CommonJS
 * today is not something a posting rule should depend on.
 *
 * Nothing about the calculation changed, and `supplierInvoice.service` still
 * re-exports both functions, so every existing caller is untouched.
 */

/** Credit notes already raised against an invoice. */
export async function getCreditedAmount(
  // Any client: the root one when accounting posts on its own, the caller's
  // transaction when it posts inside the business operation that raised the
  // document. Inside a transaction it has to be the caller's, because the invoice
  // being valued may not exist outside it yet.
  tx: Database,
  invoiceId: string
): Promise<Prisma.Decimal> {
  const links = await tx.documentLink.findMany({
    where: { targetDocumentId: invoiceId, linkType: DocumentLinkType.CREDIT_FOR },
    select: { sourceDocumentId: true },
  });
  if (links.length === 0) {
    return ZERO;
  }

  const result = await tx.document.aggregate({
    where: {
      id: { in: links.map((l) => l.sourceDocumentId) },
      status: { not: DocumentStatus.CANCELLED },
    },
    _sum: { totalAmount: true },
  });
  return result._sum.totalAmount ?? ZERO;
}

export interface InvoiceFinancials {
  invoiceTotal: Prisma.Decimal;
  disputedAmount: Prisma.Decimal;
  creditedAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  acceptedPayable: Prisma.Decimal;
  outstandingBalance: Prisma.Decimal;
  allocatableAmount: Prisma.Decimal;
}

/**
 * acceptedPayable is the undisputed value of the invoice. allocatableAmount is
 * what a payment may still settle - it excludes any dispute that has not yet
 * been cleared by a credit note, which is what stops disputed value being paid.
 */
export async function computeInvoiceFinancials(
  tx: Database,
  invoice: {
    id: string;
    totalAmount: Prisma.Decimal;
    disputedAmount: Prisma.Decimal;
    paidAmount: Prisma.Decimal;
  }
): Promise<InvoiceFinancials> {
  const creditedAmount = await getCreditedAmount(tx, invoice.id);
  const openDispute = invoice.disputedAmount.minus(creditedAmount);
  const remainingDispute = openDispute.greaterThan(0) ? openDispute : ZERO;

  const outstandingBalance = money(
    invoice.totalAmount.minus(creditedAmount).minus(invoice.paidAmount)
  );
  const allocatableAmount = money(outstandingBalance.minus(remainingDispute));

  return {
    invoiceTotal: invoice.totalAmount,
    disputedAmount: invoice.disputedAmount,
    creditedAmount,
    paidAmount: invoice.paidAmount,
    acceptedPayable: money(invoice.totalAmount.minus(invoice.disputedAmount)),
    outstandingBalance,
    allocatableAmount: allocatableAmount.greaterThan(0) ? allocatableAmount : ZERO,
  };
}
