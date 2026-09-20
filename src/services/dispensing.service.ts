import {
  DocumentStatus,
  DocumentType,
  InventoryTransactionType,
  PaymentMethod,
  StockStatus,
} from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict } from '../utils/errors';
import { calculateLineTotals, dec, money, totalsFromLines } from '../utils/decimal';
import { generateDocumentNumber, generatePaymentNumber } from '../utils/documentNumber';
import { AuditAction, logDocumentAction } from './audit.service';
import {
  assertBatchForProduct,
  assertBranchAccess,
  assertProductInCompany,
} from './authorization.service';
import {
  DocumentListFilters,
  getDocumentDetail,
  listDocuments,
} from './document.service';
import { StockMovementInput, assertBatchIssuable, recordStockMovements } from './inventory.service';
import { deliverNotifications, notifyingTransaction } from './notification.service';
import { notifyDispensingCompleted } from './notificationEvents.service';

export interface DispensingLineInput {
  productId: string;
  batchId: string;
  quantity: string;
  unitPrice?: string;
}

export interface CreateDispensingInput {
  branchId: string;
  /** Business date of the sale. Defaults to now. */
  documentDate?: Date;
  patientRef: string;
  prescriptionRef: string;
  paymentMethod: PaymentMethod;
  notes?: string;
  lines: DispensingLineInput[];
}

/**
 * Dispensing is a single atomic operation: document, line items, the outbound
 * stock movement, the patient payment and its allocation, plus the audit entry.
 * Selling prices come from the product master; client totals are ignored.
 */
export async function createDispensing(auth: AuthContext, input: CreateDispensingInput) {
  await assertBranchAccess(auth, input.branchId);

  const products = await Promise.all(
    input.lines.map((line) => assertProductInCompany(auth, line.productId))
  );
  const batches = await Promise.all(
    input.lines.map((line) => assertBatchForProduct(auth, line.batchId, line.productId))
  );

  const now = new Date();
  // Expiry is judged as of today, never as of a backdated document date: stock
  // that has already expired must not become dispensable by dating the sale
  // earlier than it is.
  batches.forEach((batch, index) => assertBatchIssuable(batch, 'dispense', index + 1, now));
  const documentDate = input.documentDate ?? now;

  const documentId = await notifyingTransaction(async (tx) => {
    const documentNumber = await generateDocumentNumber(
      tx,
      auth.companyId,
      DocumentType.DISPENSING
    );

    const lineTotals = input.lines.map((line, index) =>
      calculateLineTotals(
        line.quantity,
        line.unitPrice ?? products[index].sellingPrice,
        products[index].taxRate
      )
    );
    const totals = totalsFromLines(lineTotals);

    const document = await tx.document.create({
      data: {
        companyId: auth.companyId,
        branchId: input.branchId,
        documentNumber,
        documentType: DocumentType.DISPENSING,
        status: DocumentStatus.COMPLETED,
        documentDate,
        patientRef: input.patientRef,
        prescriptionRef: input.prescriptionRef,
        notes: input.notes,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.total,
        paidAmount: totals.total,
        balanceAmount: dec(0),
        createdById: auth.userId,
        lineItems: {
          create: input.lines.map((line, index) => ({
            lineNumber: index + 1,
            productId: line.productId,
            batchId: line.batchId,
            quantity: dec(line.quantity),
            unitPrice: money(line.unitPrice ?? products[index].sellingPrice),
            subtotal: lineTotals[index].subtotal,
            taxRate: products[index].taxRate,
            taxAmount: lineTotals[index].taxAmount,
            total: lineTotals[index].total,
            unitOfMeasure: products[index].unit,
          })),
        },
      },
      include: { lineItems: true },
    });

    const movements: StockMovementInput[] = [];
    for (const [index, line] of document.lineItems.entries()) {
      if (!line.batchId) {
        throw badRequest('Line ' + line.lineNumber + ': batch is required for dispensing');
      }
      // Stock is issued at cost, while the document is valued at the selling price.
      movements.push({
        companyId: auth.companyId,
        branchId: input.branchId,
        productId: line.productId,
        batchId: line.batchId,
        documentId: document.id,
        documentLineItemId: line.id,
        transactionType: InventoryTransactionType.DISPENSING,
        quantity: line.quantity.negated(),
        unitCost: products[index].purchasePrice,
        stockStatus: StockStatus.USABLE,
        createdById: auth.userId,
        transactionDate: documentDate,
        notes: 'Dispensed on ' + documentNumber,
      });
    }
    await recordStockMovements(tx, movements);

    const paymentNumber = await generatePaymentNumber(tx, auth.companyId);
    const payment = await tx.payment.create({
      data: {
        companyId: auth.companyId,
        branchId: input.branchId,
        paymentNumber,
        amount: totals.total,
        method: input.paymentMethod,
        // The patient pays at the counter, so the payment carries the sale's own
        // business date rather than the moment the row was written.
        paymentDate: documentDate,
        reference: input.prescriptionRef,
        notes: 'Dispensing ' + documentNumber,
        createdById: auth.userId,
      },
    });

    await tx.paymentAllocation.create({
      data: {
        paymentId: payment.id,
        documentId: document.id,
        allocatedAmount: totals.total,
      },
    });

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: document.id,
      userId: auth.userId,
      action: AuditAction.CREATE,
      reason: input.notes ?? null,
      newData: {
        documentNumber,
        patientRef: input.patientRef,
        prescriptionRef: input.prescriptionRef,
        totalAmount: totals.total.toFixed(2),
        payment: paymentNumber,
        paymentMethod: input.paymentMethod,
      },
    });

    await notifyDispensingCompleted(
      tx,
      auth,
      document,
      totals.total,
      document.lineItems.length
    );

    return document.id;
  }, deliverNotifications);

  return getDocumentDetail(auth, documentId);
}

export function listDispensing(auth: AuthContext, filters: DocumentListFilters) {
  return listDocuments(auth, DocumentType.DISPENSING, filters);
}
