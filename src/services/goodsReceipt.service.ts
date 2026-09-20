import {
  Batch,
  DocumentLinkType,
  DocumentStatus,
  DocumentType,
  InventoryTransactionType,
  Prisma,
  StockStatus,
} from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict, notFound } from '../utils/errors';
import { calculateLineTotals, dec, totalsFromLines, ZERO } from '../utils/decimal';
import { generateDocumentNumber } from '../utils/documentNumber';
import { AuditAction, logDocumentAction } from './audit.service';
import { assertBranchAccess } from './authorization.service';
import {
  DocumentListFilters,
  assertStatus,
  getDocumentDetail,
  linkDocuments,
  listDocuments,
  loadDocumentForUpdate,
  transitionDocumentStatus,
} from './document.service';
import { StockMovementInput, recordStockMovements } from './inventory.service';
import {
  getFulfilledByProduct,
  getReceivedQuantitiesByLine,
  getRequirementIdsForPurchaseOrder,
} from './fulfilment.service';
import { updateFulfilment } from './stockRequirement.service';
import { deliverNotifications, notifyingTransaction } from './notification.service';
import { notifyGoodsReceiptPosted, sumReceiptTotals } from './notificationEvents.service';

export interface GoodsReceiptLineInput {
  purchaseOrderLineItemId: string;
  /** Quantity the supplier document claims for this line. */
  quantity: string;
  acceptedQuantity: string;
  damagedQuantity: string;
  missingQuantity: string;
  batchId?: string;
  batchNumber?: string;
  expiryDate?: Date;
  notes?: string;
}

export interface CreateGoodsReceiptInput {
  purchaseOrderId: string;
  supplierRef: string;
  receiptDate?: Date;
  notes?: string;
  lines: GoodsReceiptLineInput[];
}

/**
 * Receiving model: quantity is what the supplier document claims for the line and
 * splits into accepted + damaged + missing. Physically delivered stock is
 * accepted + damaged; missing never enters the warehouse at all.
 */
function validateLineSplit(line: GoodsReceiptLineInput, lineNumber: number) {
  const quantity = dec(line.quantity);
  const accepted = dec(line.acceptedQuantity);
  const damaged = dec(line.damagedQuantity);
  const missing = dec(line.missingQuantity);

  if (quantity.lessThanOrEqualTo(0)) {
    throw badRequest('Line ' + lineNumber + ': quantity must be greater than 0');
  }
  if (accepted.isNegative() || damaged.isNegative() || missing.isNegative()) {
    throw badRequest('Line ' + lineNumber + ': quantities cannot be negative');
  }
  if (!accepted.plus(damaged).plus(missing).equals(quantity)) {
    throw badRequest(
      'Line ' +
        lineNumber +
        ': accepted + damaged + missing (' +
        accepted.plus(damaged).plus(missing).toFixed(2) +
        ') must equal the received quantity ' +
        quantity.toFixed(2)
    );
  }
  return { quantity, accepted, damaged, missing };
}

type ResolvedBatch = { id: string };

/**
 * Batches for a whole receipt in one read. Receiving 30 lines used to cost a
 * lookup per line before anything was written; the lines are resolved against a
 * single prefetch instead, and lines that name a batch number nobody has seen
 * before are created together once the whole receipt has validated.
 */
async function prefetchBatches(
  tx: Prisma.TransactionClient,
  lines: { line: GoodsReceiptLineInput; productId: string }[]
) {
  const ids = lines.map((l) => l.line.batchId).filter((id): id is string => Boolean(id));
  const numbered = lines.filter((l) => !l.line.batchId && l.line.batchNumber);

  const or: Prisma.BatchWhereInput[] = [];
  if (ids.length > 0) {
    or.push({ id: { in: ids } });
  }
  for (const { line, productId } of numbered) {
    or.push({ productId, batchNumber: line.batchNumber! });
  }
  if (or.length === 0) {
    return { byId: new Map<string, Batch>(), byNumber: new Map<string, Batch>() };
  }

  const batches = await tx.batch.findMany({ where: { OR: or } });
  return {
    byId: new Map(batches.map((b) => [b.id, b])),
    byNumber: new Map(batches.map((b) => [b.productId + ':' + b.batchNumber, b])),
  };
}

/**
 * Resolves one line against the prefetch. Returns null when the line names a new
 * batch number, which the caller creates in bulk after every line has validated.
 */
function resolveBatch(
  prefetched: { byId: Map<string, Batch>; byNumber: Map<string, Batch> },
  companyId: string,
  productId: string,
  line: GoodsReceiptLineInput,
  lineNumber: number
): ResolvedBatch | null {
  if (line.batchId) {
    const batch = prefetched.byId.get(line.batchId);
    if (!batch || batch.companyId !== companyId) {
      throw notFound('Batch not found');
    }
    if (batch.productId !== productId) {
      throw badRequest('Line ' + lineNumber + ': batch does not belong to the received product');
    }
    return batch;
  }

  if (!line.batchNumber || !line.expiryDate) {
    throw badRequest('Line ' + lineNumber + ': batchId or batchNumber with expiryDate is required');
  }
  if (line.expiryDate.getTime() <= Date.now()) {
    throw badRequest('Line ' + lineNumber + ': batch expiry date must be in the future');
  }

  const existing = prefetched.byNumber.get(productId + ':' + line.batchNumber);
  if (existing) {
    if (existing.companyId !== companyId) {
      throw notFound('Batch not found');
    }
    return existing;
  }

  return null;
}

/**
 * Creates every batch number the receipt introduced in one insert and fills the
 * resolved batch back into the prepared lines. Two lines naming the same new
 * batch share one row, which is what the per-line create used to give.
 */
async function createMissingBatches(
  tx: Prisma.TransactionClient,
  companyId: string,
  prepared: { line: GoodsReceiptLineInput; poLine: { productId: string }; batch: ResolvedBatch | null }[]
) {
  const missing = prepared.filter((p) => p.batch === null);
  if (missing.length === 0) {
    return;
  }

  const toCreate = new Map<string, { companyId: string; productId: string; batchNumber: string; expiryDate: Date }>();
  for (const p of missing) {
    const key = p.poLine.productId + ':' + p.line.batchNumber!;
    if (!toCreate.has(key)) {
      toCreate.set(key, {
        companyId,
        productId: p.poLine.productId,
        batchNumber: p.line.batchNumber!,
        expiryDate: p.line.expiryDate!,
      });
    }
  }

  const created = await tx.batch.createManyAndReturn({ data: [...toCreate.values()] });
  const createdByKey = new Map(created.map((b) => [b.productId + ':' + b.batchNumber, b]));
  for (const p of missing) {
    p.batch = createdByKey.get(p.poLine.productId + ':' + p.line.batchNumber!)!;
  }
}

export async function createGoodsReceipt(auth: AuthContext, input: CreateGoodsReceiptInput) {
  return transaction(async (tx) => {
    const po = await tx.document.findUnique({
      where: { id: input.purchaseOrderId },
      include: { lineItems: { include: { product: true } } },
    });
    if (
      !po ||
      po.companyId !== auth.companyId ||
      po.documentType !== DocumentType.PURCHASE_ORDER
    ) {
      throw notFound('Purchase order not found');
    }
    if (po.status !== DocumentStatus.APPROVED) {
      throw conflict(
        'Goods can only be received against an APPROVED purchase order; ' +
          po.documentNumber +
          ' is ' +
          po.status
      );
    }
    if (!po.branchId) {
      throw conflict('Purchase order has no delivery branch');
    }

    await assertBranchAccess(auth, po.branchId, tx);

    const alreadyReceived = await getReceivedQuantitiesByLine(tx, po.id);
    const poLineById = new Map(po.lineItems.map((l) => [l.id, l]));

    const prefetched = await prefetchBatches(
      tx,
      input.lines.flatMap((line) => {
        const poLine = poLineById.get(line.purchaseOrderLineItemId);
        return poLine ? [{ line, productId: poLine.productId }] : [];
      })
    );

    const prepared: {
      line: GoodsReceiptLineInput;
      poLine: (typeof po.lineItems)[number];
      batch: ResolvedBatch | null;
      split: ReturnType<typeof validateLineSplit>;
      lineNumber: number;
    }[] = [];
    for (const [index, line] of input.lines.entries()) {
      const lineNumber = index + 1;
      const poLine = poLineById.get(line.purchaseOrderLineItemId);
      if (!poLine) {
        throw badRequest('Line ' + lineNumber + ': purchase order line not found on ' + po.documentNumber);
      }

      const split = validateLineSplit(line, lineNumber);
      const received = alreadyReceived.get(poLine.id) ?? ZERO;
      const remaining = poLine.quantity.minus(received);
      if (split.quantity.greaterThan(remaining)) {
        throw conflict(
          'Line ' +
            lineNumber +
            ': cannot receive ' +
            split.quantity.toFixed(2) +
            ' against ' +
            po.documentNumber +
            '; only ' +
            remaining.toFixed(2) +
            ' remaining'
        );
      }

      const batch = resolveBatch(prefetched, auth.companyId, poLine.productId, line, lineNumber);
      prepared.push({ line, poLine, batch, split, lineNumber });
    }

    await createMissingBatches(tx, auth.companyId, prepared);

    const documentNumber = await generateDocumentNumber(
      tx,
      auth.companyId,
      DocumentType.GOODS_RECEIPT
    );

    const lineTotals = prepared.map((p) =>
      calculateLineTotals(p.split.quantity, p.poLine.unitPrice, p.poLine.taxRate)
    );
    const totals = totalsFromLines(lineTotals);

    const document = await tx.document.create({
      data: {
        companyId: auth.companyId,
        branchId: po.branchId,
        supplierId: po.supplierId,
        documentNumber,
        documentType: DocumentType.GOODS_RECEIPT,
        status: DocumentStatus.DRAFT,
        documentDate: input.receiptDate ?? new Date(),
        supplierRef: input.supplierRef,
        notes: input.notes,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.total,
        balanceAmount: totals.total,
        createdById: auth.userId,
        lineItems: {
          create: prepared.map((p, index) => ({
            lineNumber: index + 1,
            productId: p.poLine.productId,
            batchId: p.batch!.id,
            description: p.line.notes,
            quantity: p.split.quantity,
            acceptedQuantity: p.split.accepted,
            damagedQuantity: p.split.damaged,
            missingQuantity: p.split.missing,
            unitPrice: p.poLine.unitPrice,
            subtotal: lineTotals[index].subtotal,
            taxRate: p.poLine.taxRate,
            taxAmount: lineTotals[index].taxAmount,
            total: lineTotals[index].total,
            unitOfMeasure: p.poLine.unitOfMeasure,
            referenceLineItemId: p.poLine.id,
          })),
        },
      },
    });

    await linkDocuments(
      tx,
      auth.companyId,
      document.id,
      po.id,
      DocumentLinkType.RECEIVED_AGAINST
    );

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: document.id,
      userId: auth.userId,
      action: AuditAction.CREATE,
      reason: input.notes ?? null,
      newData: {
        documentNumber,
        purchaseOrder: po.documentNumber,
        supplierRef: input.supplierRef,
      },
    });

    return document.id;
  });
}

/**
 * Posting is the point at which a receipt becomes stock. Document status, every
 * stock movement, requirement fulfilment and the audit entry all commit together.
 */
export async function postGoodsReceipt(auth: AuthContext, id: string, reason?: string) {
  await notifyingTransaction(async (tx) => {
    const doc = await loadDocumentForUpdate(tx, auth, id, DocumentType.GOODS_RECEIPT);
    assertStatus(doc, [DocumentStatus.DRAFT], 'post');
    if (!doc.branchId) {
      throw conflict('Goods receipt has no receiving branch');
    }
    await assertBranchAccess(auth, doc.branchId, tx);

    // Claim the transition before any stock is written: a concurrent second post
    // of the same receipt is refused here rather than duplicating the delivery.
    await transitionDocumentStatus(tx, doc, [DocumentStatus.DRAFT], DocumentStatus.POSTED, 'post');

    const movements: StockMovementInput[] = [];
    // The ledger is dated by the receipt, not by when the button was pressed.
    const transactionDate = doc.documentDate;
    for (const line of doc.lineItems) {
      if (!line.batchId) {
        throw conflict('Line ' + line.lineNumber + ' has no batch');
      }
      const accepted = line.acceptedQuantity ?? ZERO;
      const damaged = line.damagedQuantity ?? ZERO;

      if (accepted.greaterThan(0)) {
        movements.push({
          companyId: auth.companyId,
          branchId: doc.branchId,
          productId: line.productId,
          batchId: line.batchId,
          documentId: doc.id,
          documentLineItemId: line.id,
          transactionType: InventoryTransactionType.RECEIPT,
          quantity: accepted,
          unitCost: line.unitPrice,
          stockStatus: StockStatus.USABLE,
          createdById: auth.userId,
          transactionDate,
        });
      }

      // Damaged goods are recorded so they can be credited, but never as usable stock.
      if (damaged.greaterThan(0)) {
        movements.push({
          companyId: auth.companyId,
          branchId: doc.branchId,
          productId: line.productId,
          batchId: line.batchId,
          documentId: doc.id,
          documentLineItemId: line.id,
          transactionType: InventoryTransactionType.DAMAGE,
          quantity: damaged,
          unitCost: line.unitPrice,
          stockStatus: StockStatus.DAMAGED,
          createdById: auth.userId,
          transactionDate,
        });
      }
      // Missing quantities never physically arrived: no stock movement at all.
    }
    await recordStockMovements(tx, movements);

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: id,
      userId: auth.userId,
      action: AuditAction.POST,
      reason: reason ?? null,
      oldData: { status: doc.status },
      newData: {
        status: DocumentStatus.POSTED,
        lines: doc.lineItems.map((l) => ({
          lineNumber: l.lineNumber,
          accepted: (l.acceptedQuantity ?? ZERO).toFixed(2),
          damaged: (l.damagedQuantity ?? ZERO).toFixed(2),
          missing: (l.missingQuantity ?? ZERO).toFixed(2),
        })),
      },
    });

    // Fulfilment first: it may raise its own requirement notification, and both
    // belong to the same commit.
    const purchaseOrder = await propagateFulfilment(tx, auth, id);

    await notifyGoodsReceiptPosted(
      tx,
      auth,
      doc,
      purchaseOrder?.documentNumber ?? 'its purchase order',
      sumReceiptTotals(doc.lineItems)
    );
  }, deliverNotifications);

  return getDocumentDetail(auth, id);
}

/**
 * Walks GRN -> PO -> requirement(s) and updates requirement fulfilment from real
 * stock. Fulfilment is re-derived from everything the requirement has received,
 * not just the purchase order this receipt belongs to: a requirement split over
 * several orders - or part-met by an internal transfer from another branch - only
 * reaches FULFILLED once every source is summed.
 */
export async function propagateFulfilment(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  goodsReceiptId: string
): Promise<{ id: string; documentNumber: string } | null> {
  // A goods receipt is raised against exactly one purchase order.
  const poLink = await tx.documentLink.findFirst({
    where: { sourceDocumentId: goodsReceiptId, linkType: DocumentLinkType.RECEIVED_AGAINST },
    select: { targetDocument: { select: { id: true, documentNumber: true } } },
  });
  if (!poLink) {
    return null;
  }

  // An order carries one FULFILLS link today, but every requirement it is linked
  // to is updated rather than all but the first being silently dropped.
  const requirementIds = await getRequirementIdsForPurchaseOrder(tx, poLink.targetDocument.id);
  for (const requirementId of requirementIds) {
    const fulfilled = await getFulfilledByProduct(tx, auth.companyId, requirementId);
    await updateFulfilment(tx, auth, requirementId, fulfilled);
  }

  // The order itself, so a caller can name it in a message and - as the receipt
  // correction does - re-value what the supplier has already billed against it.
  return poLink.targetDocument;
}

/** Damaged and missing quantities against a purchase order, per product. */
export async function getDiscrepancyByProduct(
  tx: Prisma.TransactionClient,
  companyId: string,
  purchaseOrderId: string
): Promise<Map<string, { damaged: Prisma.Decimal; missing: Prisma.Decimal }>> {
  const receiptLinks = await tx.documentLink.findMany({
    where: {
      targetDocumentId: purchaseOrderId,
      linkType: DocumentLinkType.RECEIVED_AGAINST,
    },
    select: { sourceDocumentId: true },
  });
  const receiptIds = receiptLinks.map((l) => l.sourceDocumentId);
  const result = new Map<string, { damaged: Prisma.Decimal; missing: Prisma.Decimal }>();
  if (receiptIds.length === 0) {
    return result;
  }

  const correctionLinks = await tx.documentLink.findMany({
    where: { targetDocumentId: { in: receiptIds }, linkType: DocumentLinkType.CORRECTS },
    select: { sourceDocumentId: true },
  });

  const lines = await tx.documentLineItem.findMany({
    where: {
      documentId: { in: [...receiptIds, ...correctionLinks.map((l) => l.sourceDocumentId)] },
      document: {
        status: { in: [DocumentStatus.POSTED, DocumentStatus.CORRECTED, DocumentStatus.COMPLETED] },
      },
    },
    select: { productId: true, damagedQuantity: true, missingQuantity: true },
  });

  for (const line of lines) {
    const current = result.get(line.productId) ?? { damaged: ZERO, missing: ZERO };
    result.set(line.productId, {
      damaged: current.damaged.plus(line.damagedQuantity ?? ZERO),
      missing: current.missing.plus(line.missingQuantity ?? ZERO),
    });
  }
  return result;
}

export function listGoodsReceipts(auth: AuthContext, filters: DocumentListFilters) {
  return listDocuments(auth, DocumentType.GOODS_RECEIPT, filters);
}
