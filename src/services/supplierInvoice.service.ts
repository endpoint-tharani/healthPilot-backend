import { DocumentLinkType, DocumentStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict, notFound } from '../utils/errors';
import { calculateLineTotals, dec, money, totalsFromLines, ZERO } from '../utils/decimal';
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

    const acceptedByProduct = await getAcceptedUsableByProduct(tx, auth.companyId, [po.id]);

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
