import { DocumentLinkType, DocumentStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict, notFound } from '../utils/errors';
import { calculateLineTotals, dec, money, totalsFromLines, ZERO } from '../utils/decimal';
import { generateDocumentNumber } from '../utils/documentNumber';
import { AuditAction, logDocumentAction } from './audit.service';
import {
  assertBranchInCompany,
  assertProductInCompany,
  assertSupplierInCompany,
  isBranchInScope,
} from './authorization.service';
import {
  DocumentListFilters,
  assertStatus,
  getDocumentDetail,
  linkDocuments,
  listDocuments,
  loadDocumentForUpdate,
  transitionDocumentStatus,
} from './document.service';
import { getRemainingRequirementByProduct } from './fulfilment.service';
import { deliverNotifications, notifyingTransaction } from './notification.service';
import {
  notifyPurchaseOrderApproved,
  notifyPurchaseOrderCreated,
} from './notificationEvents.service';
import { forbidden } from '../utils/errors';

export interface PurchaseOrderLineInput {
  productId: string;
  quantity: string;
  unitPrice?: string;
  taxRate?: string;
}

export interface CreatePurchaseOrderInput {
  requirementId: string;
  supplierId: string;
  deliveryBranchId: string;
  /** Business date of the order. Defaults to now. */
  documentDate?: Date;
  expectedDeliveryDate: Date;
  notes?: string;
  lines: PurchaseOrderLineInput[];
}

/**
 * Requirements a purchase order may be raised against. PARTIALLY_FULFILLED is
 * included so the shortfall left by a receipt correction can be re-ordered: on
 * REQ-0001 the 30 vials that arrived damaged or short are still owed to the
 * branch, and a follow-up order is the only legitimate way to cover them.
 */
const ORDERABLE_REQUIREMENT_STATUSES: DocumentStatus[] = [
  DocumentStatus.APPROVED,
  DocumentStatus.PARTIALLY_FULFILLED,
];

/**
 * A purchase order may not order more of a product than the requirement still
 * needs - requested, less usable stock already accepted, less what its existing
 * orders can still deliver.
 *
 * The advisory lock is the idiom the stock ledger already uses: it serialises
 * orders against one requirement for the length of the transaction, so two
 * follow-up orders raised at the same moment cannot both claim the same
 * shortfall. The requirement status is re-read under that lock for the same
 * reason.
 */
async function assertWithinRemainingRequirement(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  requirement: { id: string; documentNumber: string },
  lines: PurchaseOrderLineInput[]
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'requirement:' + requirement.id}))`;

  const current = await tx.document.findUnique({
    where: { id: requirement.id },
    select: { status: true },
  });
  if (!current || !ORDERABLE_REQUIREMENT_STATUSES.includes(current.status)) {
    throw conflict(
      'Purchase order requires an APPROVED or PARTIALLY_FULFILLED requirement; ' +
        requirement.documentNumber +
        ' is ' +
        (current?.status ?? DocumentStatus.CANCELLED)
    );
  }

  const remaining = await getRemainingRequirementByProduct(tx, auth.companyId, requirement.id);

  // Two lines for the same product draw on one shortfall, so they are summed
  // before the check rather than each being compared to the whole of it.
  const ordering = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    ordering.set(line.productId, (ordering.get(line.productId) ?? ZERO).plus(dec(line.quantity)));
  }

  for (const [productId, quantity] of ordering) {
    const row = remaining.get(productId);
    if (!row) {
      throw badRequest('Product is not on requirement ' + requirement.documentNumber);
    }
    if (quantity.greaterThan(row.remaining)) {
      throw conflict(
        'Cannot order ' +
          quantity.toFixed(2) +
          ' against ' +
          requirement.documentNumber +
          '; only ' +
          row.remaining.toFixed(2) +
          ' remaining (requested ' +
          row.requested.toFixed(2) +
          ', accepted ' +
          row.accepted.toFixed(2) +
          ', already on order ' +
          row.onOrder.toFixed(2) +
          ')'
      );
    }
  }
}

/**
 * A purchase order may only be raised against an approved or partially fulfilled
 * requirement, and never for more than that requirement still needs. Prices
 * default to the product master and every total is computed here - amounts sent
 * by the client are ignored.
 */
export async function createPurchaseOrder(auth: AuthContext, input: CreatePurchaseOrderInput) {
  const requirement = await prisma.document.findUnique({
    where: { id: input.requirementId },
    include: { lineItems: true },
  });
  if (
    !requirement ||
    requirement.companyId !== auth.companyId ||
    requirement.documentType !== DocumentType.STOCK_REQUIREMENT
  ) {
    throw notFound('Stock requirement not found');
  }
  if (!ORDERABLE_REQUIREMENT_STATUSES.includes(requirement.status)) {
    throw conflict(
      'Purchase order requires an APPROVED or PARTIALLY_FULFILLED requirement; ' +
        requirement.documentNumber +
        ' is ' +
        requirement.status
    );
  }

  const supplier = await assertSupplierInCompany(auth, input.supplierId);
  await assertBranchInCompany(auth, input.deliveryBranchId);
  if (!isBranchInScope(auth, input.deliveryBranchId)) {
    throw forbidden('Access denied for the delivery branch');
  }

  const products = await Promise.all(
    input.lines.map((line) => assertProductInCompany(auth, line.productId))
  );

  return notifyingTransaction(async (tx) => {
    await assertWithinRemainingRequirement(tx, auth, requirement, input.lines);

    const documentNumber = await generateDocumentNumber(
      tx,
      auth.companyId,
      DocumentType.PURCHASE_ORDER
    );

    const lineTotals = input.lines.map((line, index) =>
      calculateLineTotals(
        line.quantity,
        line.unitPrice ?? products[index].purchasePrice,
        line.taxRate ?? products[index].taxRate
      )
    );
    const totals = totalsFromLines(lineTotals);

    const document = await tx.document.create({
      data: {
        companyId: auth.companyId,
        branchId: input.deliveryBranchId,
        supplierId: input.supplierId,
        documentNumber,
        documentType: DocumentType.PURCHASE_ORDER,
        status: DocumentStatus.DRAFT,
        documentDate: input.documentDate ?? new Date(),
        expectedDeliveryDate: input.expectedDeliveryDate,
        notes: input.notes,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.total,
        balanceAmount: totals.total,
        createdById: auth.userId,
        lineItems: {
          create: input.lines.map((line, index) => ({
            lineNumber: index + 1,
            productId: line.productId,
            quantity: dec(line.quantity),
            unitPrice: money(line.unitPrice ?? products[index].purchasePrice),
            subtotal: lineTotals[index].subtotal,
            taxRate: money(line.taxRate ?? products[index].taxRate),
            taxAmount: lineTotals[index].taxAmount,
            total: lineTotals[index].total,
            unitOfMeasure: products[index].unit,
          })),
        },
      },
    });

    await linkDocuments(
      tx,
      auth.companyId,
      document.id,
      requirement.id,
      DocumentLinkType.FULFILLS
    );

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: document.id,
      userId: auth.userId,
      action: AuditAction.CREATE,
      reason: input.notes ?? null,
      newData: {
        documentNumber,
        requirement: requirement.documentNumber,
        totalAmount: totals.total.toFixed(2),
      },
    });

    await notifyPurchaseOrderCreated(
      tx,
      auth,
      document,
      requirement.documentNumber,
      supplier.name
    );

    return document.id;
  }, deliverNotifications);
}

export async function approvePurchaseOrder(auth: AuthContext, id: string, reason?: string) {
  await notifyingTransaction(async (tx) => {
    const doc = await loadDocumentForUpdate(tx, auth, id, DocumentType.PURCHASE_ORDER);
    assertStatus(doc, [DocumentStatus.DRAFT, DocumentStatus.SUBMITTED], 'approve');

    await transitionDocumentStatus(
      tx,
      doc,
      [DocumentStatus.DRAFT, DocumentStatus.SUBMITTED],
      DocumentStatus.APPROVED,
      'approve'
    );
    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: id,
      userId: auth.userId,
      action: AuditAction.APPROVE,
      reason: reason ?? null,
      oldData: { status: doc.status },
      newData: { status: DocumentStatus.APPROVED },
    });

    const supplier = doc.supplierId
      ? await tx.supplier.findUnique({ where: { id: doc.supplierId }, select: { name: true } })
      : null;
    await notifyPurchaseOrderApproved(tx, auth, doc, supplier?.name ?? 'the supplier');
  }, deliverNotifications);

  return getDocumentDetail(auth, id);
}

export async function cancelPurchaseOrder(auth: AuthContext, id: string, reason: string) {
  if (!reason?.trim()) {
    throw badRequest('A cancellation reason is required');
  }

  await transaction(async (tx) => {
    const doc = await loadDocumentForUpdate(tx, auth, id, DocumentType.PURCHASE_ORDER);
    assertStatus(doc, [DocumentStatus.DRAFT, DocumentStatus.SUBMITTED, DocumentStatus.APPROVED], 'cancel');

    const receipts = await tx.documentLink.count({
      where: { targetDocumentId: id, linkType: DocumentLinkType.RECEIVED_AGAINST },
    });
    if (receipts > 0) {
      throw conflict('Cannot cancel a purchase order that already has goods receipts');
    }

    await transitionDocumentStatus(
      tx,
      doc,
      [DocumentStatus.DRAFT, DocumentStatus.SUBMITTED, DocumentStatus.APPROVED],
      DocumentStatus.CANCELLED,
      'cancel'
    );
    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: id,
      userId: auth.userId,
      action: AuditAction.CANCEL,
      reason,
      oldData: { status: doc.status },
      newData: { status: DocumentStatus.CANCELLED },
    });
  });

  return getDocumentDetail(auth, id);
}

export function listPurchaseOrders(auth: AuthContext, filters: DocumentListFilters) {
  return listDocuments(auth, DocumentType.PURCHASE_ORDER, filters);
}
