import { DocumentLinkType, DocumentStatus, DocumentType } from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict, notFound } from '../utils/errors';
import { calculateLineTotals, dec, money, totalsFromLines, ZERO } from '../utils/decimal';
import { generateDocumentNumber } from '../utils/documentNumber';
import { AuditAction, logDocumentAction } from './audit.service';
import { assertBranchAccess, assertProductInCompany } from './authorization.service';
import {
  DocumentListFilters,
  getDocumentDetail,
  linkDocuments,
  listDocuments,
} from './document.service';
import { computeInvoiceFinancials } from './invoiceFinancials';
import { autoPostDocumentAccounting } from './accounting/autoPost.service';
import { deliverNotifications, notifyingTransaction } from './notification.service';
import { notifyCreditNotePosted } from './notificationEvents.service';

export interface CreditNoteLineInput {
  productId: string;
  quantity: string;
  unitPrice?: string;
  taxRate?: string;
}

export interface CreateCreditNoteInput {
  supplierInvoiceId: string;
  /** Business date of the credit note. Defaults to now. */
  documentDate?: Date;
  supplierRef?: string;
  reason: string;
  lines: CreditNoteLineInput[];
}

/**
 * A credit note clears disputed invoice value (damaged and missing goods). It is
 * a financial document only: it never creates or restores usable inventory.
 */
export async function createCreditNote(auth: AuthContext, input: CreateCreditNoteInput) {
  if (!input.reason?.trim()) {
    throw badRequest('A credit note reason is required');
  }

  const documentId = await notifyingTransaction(async (tx) => {
    const invoice = await tx.document.findUnique({
      where: { id: input.supplierInvoiceId },
      include: { lineItems: true },
    });
    if (
      !invoice ||
      invoice.companyId !== auth.companyId ||
      invoice.documentType !== DocumentType.SUPPLIER_INVOICE
    ) {
      throw notFound('Supplier invoice not found');
    }
    if (invoice.status === DocumentStatus.CANCELLED) {
      throw conflict('Cannot credit a cancelled invoice');
    }
    if (!invoice.supplierId) {
      throw conflict('Supplier invoice has no supplier');
    }
    if (!invoice.branchId) {
      throw conflict('Supplier invoice has no branch');
    }
    await assertBranchAccess(auth, invoice.branchId, tx);

    const invoiceLineByProduct = new Map(invoice.lineItems.map((l) => [l.productId, l]));
    for (const line of input.lines) {
      await assertProductInCompany(auth, line.productId, tx);
      if (!invoiceLineByProduct.has(line.productId)) {
        throw badRequest('Product is not on invoice ' + invoice.documentNumber);
      }
    }

    const lineTotals = input.lines.map((line) => {
      const invoiceLine = invoiceLineByProduct.get(line.productId)!;
      return calculateLineTotals(
        line.quantity,
        line.unitPrice ?? invoiceLine.unitPrice,
        line.taxRate ?? invoiceLine.taxRate
      );
    });
    const totals = totalsFromLines(lineTotals);

    const financials = await computeInvoiceFinancials(tx, invoice);
    const eligible = money(financials.disputedAmount.minus(financials.creditedAmount));
    if (totals.total.greaterThan(eligible)) {
      throw conflict(
        'Credit of ' +
          totals.total.toFixed(2) +
          ' exceeds the eligible disputed amount of ' +
          eligible.toFixed(2) +
          ' on ' +
          invoice.documentNumber
      );
    }

    const documentNumber = await generateDocumentNumber(
      tx,
      auth.companyId,
      DocumentType.CREDIT_NOTE
    );

    const creditNote = await tx.document.create({
      data: {
        companyId: auth.companyId,
        branchId: invoice.branchId,
        supplierId: invoice.supplierId,
        documentNumber,
        documentType: DocumentType.CREDIT_NOTE,
        status: DocumentStatus.POSTED,
        documentDate: input.documentDate ?? new Date(),
        supplierRef: input.supplierRef ?? invoice.supplierRef,
        notes: input.reason,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.total,
        balanceAmount: totals.total,
        createdById: auth.userId,
        lineItems: {
          create: input.lines.map((line, index) => {
            const invoiceLine = invoiceLineByProduct.get(line.productId)!;
            return {
              lineNumber: index + 1,
              productId: line.productId,
              quantity: dec(line.quantity),
              unitPrice: money(line.unitPrice ?? invoiceLine.unitPrice),
              subtotal: lineTotals[index].subtotal,
              taxRate: money(line.taxRate ?? invoiceLine.taxRate),
              taxAmount: lineTotals[index].taxAmount,
              total: lineTotals[index].total,
              unitOfMeasure: invoiceLine.unitOfMeasure,
              referenceLineItemId: invoiceLine.id,
            };
          }),
        },
      },
    });

    await linkDocuments(
      tx,
      auth.companyId,
      creditNote.id,
      invoice.id,
      DocumentLinkType.CREDIT_FOR
    );

    const newBalance = money(
      invoice.totalAmount.minus(financials.creditedAmount.plus(totals.total)).minus(invoice.paidAmount)
    );
    await tx.document.update({
      where: { id: invoice.id },
      data: { balanceAmount: newBalance.greaterThan(0) ? newBalance : ZERO },
    });

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: creditNote.id,
      userId: auth.userId,
      action: AuditAction.CREATE,
      reason: input.reason,
      newData: {
        documentNumber,
        creditFor: invoice.documentNumber,
        creditAmount: totals.total.toFixed(2),
      },
    });

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: invoice.id,
      userId: auth.userId,
      action: AuditAction.CREDIT_APPLIED,
      reason: input.reason,
      oldData: { balanceAmount: invoice.balanceAmount.toFixed(2) },
      newData: {
        balanceAmount: newBalance.toFixed(2),
        creditNote: documentNumber,
        creditAmount: totals.total.toFixed(2),
      },
    });

    await notifyCreditNotePosted(
      tx,
      auth,
      creditNote,
      invoice.documentNumber,
      totals.total
    );

    // A credit note is raised POSTED, so this is its finalisation. Whether it
    // produces a journal depends on what the invoice actually booked: in the
    // standard flow it clears disputed value the invoice journal never recognised
    // as a liability, and the honest answer is a memo rather than a movement. The
    // accounting service decides which, and records the reason on the document
    // either way.
    await autoPostDocumentAccounting(tx, auth, creditNote.id, DocumentType.CREDIT_NOTE);

    return creditNote.id;
  }, deliverNotifications);

  return getDocumentDetail(auth, documentId);
}

export function listCreditNotes(auth: AuthContext, filters: DocumentListFilters) {
  return listDocuments(auth, DocumentType.CREDIT_NOTE, filters);
}
