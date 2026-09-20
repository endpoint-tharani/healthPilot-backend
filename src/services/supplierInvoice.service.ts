import { DocumentLinkType, DocumentStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict, notFound } from '../utils/errors';
import { LineTotals, calculateLineTotals, dec, money, totalsFromLines, ZERO } from '../utils/decimal';
import { generateDocumentNumber } from '../utils/documentNumber';
import { AuditAction, logDocumentAction } from './audit.service';
import { assertProductInCompany } from './authorization.service';
import {
  DocumentListFilters,
  getDocumentDetail,
  linkDocuments,
  listDocuments,
} from './document.service';
import { getAcceptedUsableByProduct } from './fulfilment.service';
import { deliverNotifications, notifyingTransaction } from './notification.service';
import { notifySupplierInvoiceCreated } from './notificationEvents.service';
import { assertBranchAccess } from './authorization.service';

export interface InvoiceLineInput {
  productId: string;
  /** Quantity the supplier is billing for. */
  quantity: string;
  unitPrice?: string;
  taxRate?: string;
}

export interface CreateInvoiceInput {
  purchaseOrderId: string;
  supplierRef: string;
  invoiceDate?: Date;
  dueDate?: Date;
  notes?: string;
  lines: InvoiceLineInput[];
}

/**
 * The invoice is booked at the value the supplier claims, but the payable amount
 * is recomputed from the stock actually accepted (corrections included). The
 * difference is the disputed amount, which a credit note later clears.
 */
export async function createSupplierInvoice(auth: AuthContext, input: CreateInvoiceInput) {
  const documentId = await notifyingTransaction(async (tx) => {
    const po = await tx.document.findUnique({
      where: { id: input.purchaseOrderId },
      include: { lineItems: true },
    });
    if (
      !po ||
      po.companyId !== auth.companyId ||
      po.documentType !== DocumentType.PURCHASE_ORDER
    ) {
      throw notFound('Purchase order not found');
    }
    if (!po.supplierId) {
      throw conflict('Purchase order has no supplier');
    }
    if (!po.branchId) {
      throw conflict('Purchase order has no delivery branch');
    }
    await assertBranchAccess(auth, po.branchId, tx);

    const poLineByProduct = new Map(po.lineItems.map((l) => [l.productId, l]));
    for (const line of input.lines) {
      await assertProductInCompany(auth, line.productId, tx);
      if (!poLineByProduct.has(line.productId)) {
        throw badRequest('Product is not on purchase order ' + po.documentNumber);
      }
    }

    // Company-wide, not per branch: the supplier is owed for everything accepted
    // from them against this order, wherever in the network it was delivered.
    const acceptedByProduct = await getAcceptedUsableByProduct(tx, auth.companyId, [po.id], null);

    const lineTotals = input.lines.map((line) => {
      const poLine = poLineByProduct.get(line.productId)!;
      return calculateLineTotals(
        line.quantity,
        line.unitPrice ?? poLine.unitPrice,
        line.taxRate ?? poLine.taxRate
      );
    });
    const invoiceTotals = totalsFromLines(lineTotals);

    // Payable value: billed quantity capped at the quantity actually accepted.
    const payableTotals = input.lines.map((line) => {
      const poLine = poLineByProduct.get(line.productId)!;
      const billed = dec(line.quantity);
      const accepted = acceptedByProduct.get(line.productId) ?? ZERO;
      const payableQty = accepted.lessThan(billed) ? accepted : billed;
      return calculateLineTotals(
        payableQty,
        line.unitPrice ?? poLine.unitPrice,
        line.taxRate ?? poLine.taxRate
      );
    });
    const payable = totalsFromLines(payableTotals);
    const disputed = money(invoiceTotals.total.minus(payable.total));

    const documentNumber = await generateDocumentNumber(
      tx,
      auth.companyId,
      DocumentType.SUPPLIER_INVOICE
    );

    const invoice = await tx.document.create({
      data: {
        companyId: auth.companyId,
        branchId: po.branchId,
        supplierId: po.supplierId,
        documentNumber,
        documentType: DocumentType.SUPPLIER_INVOICE,
        status: disputed.greaterThan(0) ? DocumentStatus.DISCREPANT : DocumentStatus.POSTED,
        documentDate: input.invoiceDate ?? new Date(),
        expectedDeliveryDate: input.dueDate,
        supplierRef: input.supplierRef,
        notes: input.notes,
        subtotal: invoiceTotals.subtotal,
        taxAmount: invoiceTotals.taxAmount,
        totalAmount: invoiceTotals.total,
        paidAmount: ZERO,
        balanceAmount: invoiceTotals.total,
        disputedAmount: disputed,
        createdById: auth.userId,
        lineItems: {
          create: input.lines.map((line, index) => {
            const poLine = poLineByProduct.get(line.productId)!;
            const accepted = acceptedByProduct.get(line.productId) ?? ZERO;
            const billed = dec(line.quantity);
            return {
              lineNumber: index + 1,
              productId: line.productId,
              quantity: billed,
              acceptedQuantity: accepted.lessThan(billed) ? accepted : billed,
              unitPrice: money(line.unitPrice ?? poLine.unitPrice),
              subtotal: lineTotals[index].subtotal,
              taxRate: money(line.taxRate ?? poLine.taxRate),
              taxAmount: lineTotals[index].taxAmount,
              total: lineTotals[index].total,
              unitOfMeasure: poLine.unitOfMeasure,
              referenceLineItemId: poLine.id,
            };
          }),
        },
      },
    });

    await linkDocuments(
      tx,
      auth.companyId,
      invoice.id,
      po.id,
      DocumentLinkType.INVOICED_AGAINST
    );

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: invoice.id,
      userId: auth.userId,
      action: AuditAction.CREATE,
      reason: input.notes ?? null,
      newData: {
        documentNumber,
        purchaseOrder: po.documentNumber,
        invoiceTotal: invoiceTotals.total.toFixed(2),
        acceptedPayable: payable.total.toFixed(2),
        disputedAmount: disputed.toFixed(2),
      },
    });

    const supplier = await tx.supplier.findUnique({
      where: { id: po.supplierId },
      select: { name: true },
    });
    await notifySupplierInvoiceCreated(
      tx,
      auth,
      invoice,
      supplier?.name ?? 'the supplier',
      invoiceTotals.total,
      disputed
    );

    return invoice.id;
  }, deliverNotifications);

  return getInvoice(auth, documentId);
}

/* ----------------------------------------- re-valuing after a correction ---- */

/**
 * Re-values every supplier invoice raised against a purchase order, after the
 * accepted quantity behind that order changed.
 *
 * The disputed amount is settled at invoicing time from the accepted position as
 * it stood then, which is correct only while that position holds. A receiving
 * correction raised AFTER the invoice - stock condemned on inspection a week
 * later, a recount that finds a case short - silently invalidated it: the
 * invoice went on claiming the supplier was owed for goods the warehouse no
 * longer had, and because `allocatableAmount` is derived from the stored
 * dispute, a payment for the full amount was still permitted. The money left the
 * company for stock it does not hold.
 *
 * So the dispute is recomputed from the ledger rather than trusted, and the
 * guard that stops disputed value being paid follows from it automatically:
 * raising `disputedAmount` lowers `allocatableAmount` by the same amount, and a
 * payment beyond it is refused by the existing allocation check.
 *
 * Invoices are re-valued oldest first and draw on one shared pool of accepted
 * quantity, so an order invoiced in two instalments does not let both of them
 * claim the same goods.
 */
export async function recomputeInvoiceDisputes(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  purchaseOrderId: string
): Promise<void> {
  const invoiceLinks = await tx.documentLink.findMany({
    where: { targetDocumentId: purchaseOrderId, linkType: DocumentLinkType.INVOICED_AGAINST },
    select: { sourceDocumentId: true },
  });
  if (invoiceLinks.length === 0) {
    return;
  }

  const invoices = await tx.document.findMany({
    where: {
      id: { in: invoiceLinks.map((link) => link.sourceDocumentId) },
      companyId: auth.companyId,
      documentType: DocumentType.SUPPLIER_INVOICE,
      status: { not: DocumentStatus.CANCELLED },
    },
    include: { lineItems: { orderBy: { lineNumber: 'asc' } } },
    orderBy: [{ documentDate: 'asc' }, { documentNumber: 'asc' }],
  });
  if (invoices.length === 0) {
    return;
  }

  // Company-wide, for the same reason invoicing itself is: the supplier is owed
  // for what was accepted from them, wherever it was delivered.
  const accepted = await getAcceptedUsableByProduct(tx, auth.companyId, [purchaseOrderId], null);
  const unclaimed = new Map(accepted);

  for (const invoice of invoices) {
    const payableLines: LineTotals[] = [];
    const lineUpdates: { id: string; acceptedQuantity: Prisma.Decimal }[] = [];

    for (const line of invoice.lineItems) {
      const billed = line.quantity;
      const available = unclaimed.get(line.productId) ?? ZERO;
      const payableQty = available.lessThan(billed) ? available : billed;
      unclaimed.set(line.productId, available.minus(payableQty));

      payableLines.push(calculateLineTotals(payableQty, line.unitPrice, line.taxRate));
      lineUpdates.push({ id: line.id, acceptedQuantity: payableQty });
    }

    const payable = totalsFromLines(payableLines);
    const rawDispute = invoice.totalAmount.minus(payable.total);
    const disputed = money(rawDispute.greaterThan(0) ? rawDispute : ZERO);

    if (disputed.equals(invoice.disputedAmount)) {
      continue;
    }

    for (const update of lineUpdates) {
      await tx.documentLineItem.update({
        where: { id: update.id },
        data: { acceptedQuantity: update.acceptedQuantity },
      });
    }

    // A dispute that reopens moves the invoice back to DISCREPANT even if it was
    // already marked PAID: the status has to say that something is owed back,
    // rather than quietly presenting a settled invoice nobody would look at.
    const credited = await getCreditedAmount(tx, invoice.id);
    const outstanding = money(invoice.totalAmount.minus(credited).minus(invoice.paidAmount));
    const nextStatus = disputed.greaterThan(0)
      ? DocumentStatus.DISCREPANT
      : outstanding.greaterThan(0)
        ? DocumentStatus.POSTED
        : DocumentStatus.PAID;

    await tx.document.update({
      where: { id: invoice.id },
      data: {
        disputedAmount: disputed,
        balanceAmount: outstanding.greaterThan(0) ? outstanding : ZERO,
        status: nextStatus,
      },
    });

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: invoice.id,
      userId: auth.userId,
      action: AuditAction.DISPUTE_RECALCULATED,
      reason: 'Accepted quantity changed by a receiving correction after invoicing',
      oldData: {
        disputedAmount: invoice.disputedAmount.toFixed(2),
        acceptedPayable: money(invoice.totalAmount.minus(invoice.disputedAmount)).toFixed(2),
        status: invoice.status,
      },
      newData: {
        disputedAmount: disputed.toFixed(2),
        acceptedPayable: payable.total.toFixed(2),
        status: nextStatus,
        // Surfaced rather than corrected: money already paid cannot be unpaid
        // here, and a credit note or a supplier refund is the right answer.
        overpaid: invoice.paidAmount.greaterThan(payable.total)
          ? money(invoice.paidAmount.minus(payable.total)).toFixed(2)
          : '0.00',
      },
    });
  }
}

/** Credit notes already raised against an invoice. */
export async function getCreditedAmount(
  tx: Prisma.TransactionClient,
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
  tx: Prisma.TransactionClient,
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

export async function getInvoice(auth: AuthContext, id: string) {
  const detail = await getDocumentDetail(auth, id);
  if (detail.documentType !== DocumentType.SUPPLIER_INVOICE) {
    throw notFound('Supplier invoice not found');
  }

  const invoice = await prisma.document.findUniqueOrThrow({
    where: { id },
    select: { id: true, totalAmount: true, disputedAmount: true, paidAmount: true },
  });
  const financials = await transaction((tx) => computeInvoiceFinancials(tx, invoice));

  return {
    ...detail,
    financials: {
      invoiceTotal: financials.invoiceTotal.toFixed(2),
      acceptedPayable: financials.acceptedPayable.toFixed(2),
      disputedAmount: financials.disputedAmount.toFixed(2),
      creditedAmount: financials.creditedAmount.toFixed(2),
      paidAmount: financials.paidAmount.toFixed(2),
      outstandingBalance: financials.outstandingBalance.toFixed(2),
      allocatableAmount: financials.allocatableAmount.toFixed(2),
    },
  };
}

export function listSupplierInvoices(auth: AuthContext, filters: DocumentListFilters) {
  return listDocuments(auth, DocumentType.SUPPLIER_INVOICE, filters);
}
