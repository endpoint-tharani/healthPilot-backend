import {
  DocumentLinkType,
  DocumentStatus,
  DocumentType,
  InventoryTransactionType,
  Prisma,
  StockStatus,
} from '@prisma/client';
import { prisma } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict, notFound } from '../utils/errors';
import { calculateLineTotals, dec, money, totalsFromLines, ZERO } from '../utils/decimal';
import { generateDocumentNumber } from '../utils/documentNumber';
import { AuditAction, logDocumentAction } from './audit.service';
import {
  assertBatchForProduct,
  assertBranchAccess,
  assertProductInCompany,
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
import {
  StockMovementInput,
  assertBatchIssuable,
  bucketKey,
  getSourceableStock,
  lockStockBuckets,
  recordStockMovements,
} from './inventory.service';
import {
  getFulfilledByProduct,
  getRemainingRequirementByProduct,
} from './fulfilment.service';
import { updateFulfilment } from './stockRequirement.service';
import { deliverNotifications, notifyingTransaction } from './notification.service';
import {
  notifyTransferCreated,
  notifyTransferDispatched,
  notifyTransferReceived,
} from './notificationEvents.service';

export interface TransferLineInput {
  productId: string;
  batchId: string;
  quantity: string;
}

export interface CreateTransferInput {
  sourceBranchId: string;
  destinationBranchId: string;
  /** Business date of the transfer. Defaults to now. */
  documentDate?: Date;
  expectedDate?: Date;
  notes?: string;
  /** Optional: the requirement this transfer is raised to help fulfil. */
  requirementId?: string;
  lines: TransferLineInput[];
}

/**
 * Requirements a transfer may be raised against. The same two statuses purchase
 * orders accept, for the same reason: an approved requirement is still owed its
 * stock, and a partially fulfilled one is owed the rest of it.
 */
const SOURCEABLE_REQUIREMENT_STATUSES: DocumentStatus[] = [
  DocumentStatus.APPROVED,
  DocumentStatus.PARTIALLY_FULFILLED,
];

/**
 * A transfer raised for a requirement may not send more of a product than that
 * requirement still needs, counting everything already received and everything
 * already committed on open orders and other transfers.
 *
 * This is the transfer half of the rule purchase orders enforce, and it takes the
 * same advisory lock on the same key, so an order and a transfer raised at the
 * same instant cannot both claim the last 30 vials - whichever reaches the lock
 * first is measured against a position that already includes the other.
 */
async function assertWithinRemainingRequirement(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  requirement: { id: string; documentNumber: string },
  lines: TransferLineInput[]
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'requirement:' + requirement.id}))`;

  const current = await tx.document.findUnique({
    where: { id: requirement.id },
    select: { status: true },
  });
  if (!current || !SOURCEABLE_REQUIREMENT_STATUSES.includes(current.status)) {
    throw conflict(
      'A transfer against a requirement needs it APPROVED or PARTIALLY_FULFILLED; ' +
        requirement.documentNumber +
        ' is ' +
        (current?.status ?? DocumentStatus.CANCELLED)
    );
  }

  const remaining = await getRemainingRequirementByProduct(tx, auth.companyId, requirement.id);

  // Two lines for one product draw on a single shortfall, so they are summed
  // before the check rather than each being compared to the whole of it.
  const sending = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    sending.set(line.productId, (sending.get(line.productId) ?? ZERO).plus(dec(line.quantity)));
  }

  for (const [productId, quantity] of sending) {
    const row = remaining.get(productId);
    if (!row) {
      throw badRequest('Product is not on requirement ' + requirement.documentNumber);
    }
    if (quantity.greaterThan(row.remaining)) {
      throw conflict(
        'Cannot transfer ' +
          quantity.toFixed(2) +
          ' against ' +
          requirement.documentNumber +
          '; only ' +
          row.remaining.toFixed(2) +
          ' remaining (requested ' +
          row.requested.toFixed(2) +
          ', received ' +
          row.accepted.toFixed(2) +
          ', already on order ' +
          row.onOrder.toFixed(2) +
          ', already in transit ' +
          row.onTransfer.toFixed(2) +
          ')'
      );
    }
  }
}

/**
 * Only usable stock can be transferred: damaged and quarantined buckets are never
 * touched, so a transfer cannot launder unusable stock into another branch.
 *
 * A transfer may optionally name the requirement it is meeting. That link is what
 * lets internal stock count towards fulfilment, and it constrains the transfer in
 * return: it must land at the branch that asked, carry only products that were
 * asked for, and stay inside the quantity still outstanding.
 */
export async function createStockTransfer(auth: AuthContext, input: CreateTransferInput) {
  if (input.sourceBranchId === input.destinationBranchId) {
    throw badRequest('Source and destination branches must be different');
  }

  const source = await assertBranchAccess(auth, input.sourceBranchId);
  // Destination only has to exist in the company; the receiving branch authorises receipt.
  const destination = await prisma.branch.findFirst({
    where: { id: input.destinationBranchId, companyId: auth.companyId },
  });
  if (!destination) {
    throw badRequest('Destination branch not found');
  }

  const products = await Promise.all(
    input.lines.map((line) => assertProductInCompany(auth, line.productId))
  );
  // Expired stock, and stock whose batch has been condemned or quarantined, may
  // not be sent anywhere - the same rule dispensing applies, from the same
  // function. Checked before the transfer exists, so it is never raised at all.
  const batches = await Promise.all(
    input.lines.map((line) => assertBatchForProduct(auth, line.batchId, line.productId))
  );
  batches.forEach((batch, index) => assertBatchIssuable(batch, 'transfer', index + 1));

  const requirement = input.requirementId
    ? await loadRequirementForTransfer(auth, input.requirementId, input.destinationBranchId)
    : null;

  const documentId = await notifyingTransaction(async (tx) => {
    if (requirement) {
      await assertWithinRemainingRequirement(tx, auth, requirement, input.lines);
    }

    const sourceStock = await checkSourceStock(tx, auth, input);

    const documentNumber = await generateDocumentNumber(
      tx,
      auth.companyId,
      DocumentType.STOCK_TRANSFER
    );

    /**
     * An internal move carries the cost the stock already has, never the product
     * master price. Branch B holding a batch bought at 450 must send it at 450:
     * valuing it at today's 500 would create 50 a unit of inventory value out of
     * nothing and quietly enrich the receiving branch. Batch is part of the bucket
     * key, so two batches at two prices keep two costs rather than being averaged.
     *
     * There is no tax on an internal transfer: nothing is being sold.
     */
    const unitCosts = input.lines.map(
      (line) => sourceStock.get(line.productId + ':' + line.batchId) ?? products[0].purchasePrice
    );
    const lineTotals = input.lines.map((line, index) =>
      calculateLineTotals(line.quantity, unitCosts[index], 0)
    );
    const totals = totalsFromLines(lineTotals);

    const document = await tx.document.create({
      data: {
        companyId: auth.companyId,
        sourceBranchId: input.sourceBranchId,
        destinationBranchId: input.destinationBranchId,
        documentNumber,
        documentType: DocumentType.STOCK_TRANSFER,
        status: DocumentStatus.DRAFT,
        documentDate: input.documentDate ?? new Date(),
        expectedDeliveryDate: input.expectedDate,
        notes: input.notes,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.total,
        createdById: auth.userId,
        lineItems: {
          create: input.lines.map((line, index) => ({
            lineNumber: index + 1,
            productId: line.productId,
            batchId: line.batchId,
            quantity: dec(line.quantity),
            unitPrice: money(unitCosts[index]),
            subtotal: lineTotals[index].subtotal,
            taxRate: dec(0),
            taxAmount: lineTotals[index].taxAmount,
            total: lineTotals[index].total,
            unitOfMeasure: products[index].unit,
          })),
        },
      },
    });

    // Direction follows the convention every other link already uses: the newer
    // document is the source, the document it was raised against is the target.
    // A purchase order FULFILLS a requirement; a transfer is TRANSFER_FOR one.
    if (requirement) {
      await linkDocuments(
        tx,
        auth.companyId,
        document.id,
        requirement.id,
        DocumentLinkType.TRANSFER_FOR
      );
    }

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: document.id,
      userId: auth.userId,
      action: AuditAction.CREATE,
      reason: input.notes ?? null,
      newData: {
        documentNumber,
        sourceBranchId: input.sourceBranchId,
        destinationBranchId: input.destinationBranchId,
        ...(requirement ? { requirement: requirement.documentNumber } : {}),
      },
    });

    // The requirement's own timeline records that stock was allocated to it, so
    // the branch that raised it sees the sourcing decision without having to open
    // the transfer.
    if (requirement) {
      await logDocumentAction(tx, {
        companyId: auth.companyId,
        documentId: requirement.id,
        userId: auth.userId,
        action: AuditAction.TRANSFER_ALLOCATED,
        reason:
          'Internal sourcing: ' +
          totalQuantity(input.lines).toFixed(2) +
          ' units allocated from ' +
          source.name +
          ' on ' +
          documentNumber,
        newData: {
          transfer: documentNumber,
          sourceBranch: source.name,
          quantity: totalQuantity(input.lines).toFixed(2),
        },
      });
    }

    await notifyTransferCreated(
      tx,
      auth,
      document,
      source.name,
      destination.name,
      requirement?.documentNumber
    );

    return document.id;
  }, deliverNotifications);

  return getDocumentDetail(auth, documentId);
}

/**
 * Locks the stock this transfer draws on, then checks it is really there, and
 * returns what each bucket actually costs.
 *
 * The lock matters as much as the check. Creating a transfer posts no movement,
 * so without it two transfers raised at the same instant both read the same 40
 * vials and both succeed - and the second one only fails much later, at dispatch,
 * after a branch has been told its stock is coming. Taking the ledger's own
 * bucket lock here serialises the two, and the loser is refused immediately.
 *
 * Availability is net of transfers already raised out of the same bucket, which
 * is what makes a promise made to one requirement visible to the next.
 */
async function checkSourceStock(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  input: CreateTransferInput
): Promise<Map<string, Prisma.Decimal>> {
  const keys = input.lines.map((line) =>
    bucketKey({
      branchId: input.sourceBranchId,
      productId: line.productId,
      batchId: line.batchId,
      stockStatus: StockStatus.USABLE,
    })
  );
  await lockStockBuckets(tx, keys);

  const buckets = await getSourceableStock(
    tx,
    {
      companyId: auth.companyId,
      branchId: input.sourceBranchId,
      stockStatus: StockStatus.USABLE,
      productId: { in: [...new Set(input.lines.map((line) => line.productId))] },
      batchId: { in: [...new Set(input.lines.map((line) => line.batchId))] },
    },
    {
      companyId: auth.companyId,
      branchIds: [input.sourceBranchId],
      productIds: [...new Set(input.lines.map((line) => line.productId))],
    }
  );

  const byBucket = new Map(buckets.map((bucket) => [bucket.productId + ':' + bucket.batchId, bucket]));

  // Two lines drawing on one bucket are summed before the check, so a transfer
  // cannot split a shortage across its own lines to slip past it.
  const wanted = new Map<string, Prisma.Decimal>();
  for (const line of input.lines) {
    const key = line.productId + ':' + line.batchId;
    wanted.set(key, (wanted.get(key) ?? ZERO).plus(dec(line.quantity)));
  }

  const unitCostByBucket = new Map<string, Prisma.Decimal>();
  for (const [index, line] of input.lines.entries()) {
    const key = line.productId + ':' + line.batchId;
    const bucket = byBucket.get(key);
    const available = bucket?.available ?? ZERO;
    const required = wanted.get(key) ?? ZERO;

    if (available.lessThan(required)) {
      const committed = bucket?.committed ?? ZERO;
      throw conflict(
        'Line ' +
          (index + 1) +
          ': insufficient usable stock at source branch; available ' +
          available.toFixed(2) +
          (committed.greaterThan(0)
            ? ' (' + committed.toFixed(2) + ' already committed to other transfers)'
            : '') +
          ', required ' +
          required.toFixed(2)
      );
    }
    unitCostByBucket.set(key, bucket!.unitCost);
  }

  return unitCostByBucket;
}

/** Total units on a transfer, for the requirement's activity entry. */
function totalQuantity(lines: TransferLineInput[]): Prisma.Decimal {
  return lines.reduce<Prisma.Decimal>((acc, line) => acc.plus(dec(line.quantity)), ZERO);
}

/**
 * The requirement a transfer names, checked before anything is written.
 *
 * The destination must be the branch that raised the requirement. A transfer into
 * some third branch does not put stock where it was asked for, so counting it as
 * fulfilment would be a lie the ledger could not support.
 */
async function loadRequirementForTransfer(
  auth: AuthContext,
  requirementId: string,
  destinationBranchId: string
) {
  const requirement = await prisma.document.findFirst({
    where: {
      id: requirementId,
      companyId: auth.companyId,
      documentType: DocumentType.STOCK_REQUIREMENT,
    },
    select: { id: true, documentNumber: true, status: true, branchId: true },
  });
  if (!requirement) {
    throw notFound('Stock requirement not found');
  }
  if (requirement.branchId !== destinationBranchId) {
    throw badRequest(
      'The destination branch must be the branch that raised ' + requirement.documentNumber
    );
  }
  return requirement;
}

/** Dispatch removes stock from the source branch; the destination gains nothing yet. */
export async function dispatchStockTransfer(auth: AuthContext, id: string, reason?: string) {
  await notifyingTransaction(async (tx) => {
    const doc = await loadDocumentForUpdate(tx, auth, id, DocumentType.STOCK_TRANSFER);
    assertStatus(doc, [DocumentStatus.DRAFT], 'dispatch');
    if (!doc.sourceBranchId) {
      throw conflict('Transfer has no source branch');
    }
    await assertBranchAccess(auth, doc.sourceBranchId, tx);

    // Re-checked at dispatch, not just at creation: a transfer raised last week
    // for a batch that expires tomorrow must not be allowed to leave the
    // warehouse next month.
    await assertTransferBatchesIssuable(tx, doc.lineItems);

    // Claimed before the ledger is touched, so two simultaneous dispatches of the
    // same transfer cannot both take the stock out of the source branch.
    await transitionDocumentStatus(
      tx,
      doc,
      [DocumentStatus.DRAFT],
      DocumentStatus.DISPATCHED,
      'dispatch'
    );

    const movements: StockMovementInput[] = [];
    for (const line of doc.lineItems) {
      if (!line.batchId) {
        throw conflict('Line ' + line.lineNumber + ' has no batch');
      }
      movements.push({
        companyId: auth.companyId,
        branchId: doc.sourceBranchId,
        productId: line.productId,
        batchId: line.batchId,
        documentId: doc.id,
        documentLineItemId: line.id,
        transactionType: InventoryTransactionType.TRANSFER_OUT,
        quantity: line.quantity.negated(),
        unitCost: line.unitPrice,
        stockStatus: StockStatus.USABLE,
        createdById: auth.userId,
        transactionDate: doc.documentDate,
        notes: 'Dispatched on ' + doc.documentNumber,
      });
    }
    await recordStockMovements(tx, movements);

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: id,
      userId: auth.userId,
      action: AuditAction.DISPATCH,
      reason: reason ?? null,
      oldData: { status: doc.status },
      newData: { status: DocumentStatus.DISPATCHED },
    });

    const branches = await transferBranchNames(tx, doc);
    // Dispatch moves no requirement forward - it only names the one this stock is
    // travelling towards, so the receiving branch knows what it is signing for.
    const requirementNumber = await linkedRequirementNumber(tx, doc.id);
    await notifyTransferDispatched(
      tx,
      auth,
      doc,
      branches.source,
      branches.destination,
      requirementNumber
    );
  }, deliverNotifications);

  return getDocumentDetail(auth, id);
}

/** Receipt adds the stock at the destination branch and closes the transfer. */
export async function receiveStockTransfer(auth: AuthContext, id: string, reason?: string) {
  await notifyingTransaction(async (tx) => {
    const doc = await loadDocumentForUpdate(tx, auth, id, DocumentType.STOCK_TRANSFER);
    assertStatus(doc, [DocumentStatus.DISPATCHED], 'receive');
    if (!doc.destinationBranchId) {
      throw conflict('Transfer has no destination branch');
    }
    await assertBranchAccess(auth, doc.destinationBranchId, tx);

    // Same claim as dispatch: receiving twice would book the arrival twice.
    await transitionDocumentStatus(
      tx,
      doc,
      [DocumentStatus.DISPATCHED],
      DocumentStatus.RECEIVED,
      'receive'
    );

    const movements: StockMovementInput[] = [];
    for (const line of doc.lineItems) {
      if (!line.batchId) {
        throw conflict('Line ' + line.lineNumber + ' has no batch');
      }
      movements.push({
        companyId: auth.companyId,
        branchId: doc.destinationBranchId,
        productId: line.productId,
        batchId: line.batchId,
        documentId: doc.id,
        documentLineItemId: line.id,
        transactionType: InventoryTransactionType.TRANSFER_IN,
        quantity: line.quantity,
        unitCost: line.unitPrice,
        stockStatus: StockStatus.USABLE,
        createdById: auth.userId,
        transactionDate: doc.documentDate,
        notes: 'Received on ' + doc.documentNumber,
      });
    }
    await recordStockMovements(tx, movements);

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: id,
      userId: auth.userId,
      action: AuditAction.RECEIVE,
      reason: reason ?? null,
      oldData: { status: doc.status },
      newData: { status: DocumentStatus.RECEIVED },
    });

    // Receipt is the moment internal stock becomes fulfilment. Dispatch wrote only
    // the TRANSFER_OUT leg, so nothing above this line could have moved the
    // requirement; the TRANSFER_IN rows just posted are what it reads.
    const requirementNumber = await propagateTransferFulfilment(tx, auth, doc.id);

    const branches = await transferBranchNames(tx, doc);
    await notifyTransferReceived(tx, auth, doc, branches.destination, requirementNumber);
  }, deliverNotifications);

  return getDocumentDetail(auth, id);
}

/**
 * Every batch on a transfer, checked against the issuable rule as it stands now.
 * The document's own line include carries the batch number and expiry but not
 * its status, so the batch rows are read here rather than trusting the snapshot.
 */
async function assertTransferBatchesIssuable(
  tx: Prisma.TransactionClient,
  lines: { lineNumber: number; batchId: string | null }[]
): Promise<void> {
  const batchIds = [...new Set(lines.map((line) => line.batchId).filter((id): id is string => Boolean(id)))];
  if (batchIds.length === 0) {
    return;
  }

  const batches = await tx.batch.findMany({
    where: { id: { in: batchIds } },
    select: { id: true, batchNumber: true, expiryDate: true, status: true },
  });
  const byId = new Map(batches.map((batch) => [batch.id, batch]));

  const now = new Date();
  for (const line of lines) {
    if (!line.batchId) {
      continue;
    }
    const batch = byId.get(line.batchId);
    if (!batch) {
      throw notFound('Batch not found');
    }
    assertBatchIssuable(batch, 'dispatch', line.lineNumber, now);
  }
}

/** The requirement a transfer was raised for, by number, for a message. */
async function linkedRequirementNumber(
  tx: Prisma.TransactionClient,
  transferId: string
): Promise<string | undefined> {
  const link = await tx.documentLink.findFirst({
    where: { sourceDocumentId: transferId, linkType: DocumentLinkType.TRANSFER_FOR },
    select: { targetDocument: { select: { documentNumber: true } } },
  });
  return link?.targetDocument.documentNumber;
}

/**
 * Updates every requirement this transfer was raised for, from real stock.
 *
 * Fulfilment is re-derived from the requirement's whole history rather than
 * incremented by this transfer, which is how the procurement side already works:
 * a requirement met partly by a supplier and partly by two branches only reaches
 * FULFILLED when all three are summed, and a status is never inferred from the
 * one document that happened to move last.
 */
async function propagateTransferFulfilment(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  transferId: string
): Promise<string | undefined> {
  const links = await tx.documentLink.findMany({
    where: { sourceDocumentId: transferId, linkType: DocumentLinkType.TRANSFER_FOR },
    select: { targetDocument: { select: { id: true, documentNumber: true } } },
  });

  for (const link of links) {
    const fulfilled = await getFulfilledByProduct(tx, auth.companyId, link.targetDocument.id);
    await updateFulfilment(tx, auth, link.targetDocument.id, fulfilled);
  }

  // Returned only so the caller can name the requirement in a message.
  return links[0]?.targetDocument.documentNumber;
}

/** Both ends of a transfer by name, for the notification message. */
async function transferBranchNames(
  tx: Prisma.TransactionClient,
  doc: { sourceBranchId: string | null; destinationBranchId: string | null }
): Promise<{ source: string; destination: string }> {
  const ids = [doc.sourceBranchId, doc.destinationBranchId].filter(
    (id): id is string => Boolean(id)
  );
  const branches = await tx.branch.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const byId = new Map(branches.map((branch) => [branch.id, branch.name]));
  return {
    source: (doc.sourceBranchId && byId.get(doc.sourceBranchId)) || 'the source branch',
    destination:
      (doc.destinationBranchId && byId.get(doc.destinationBranchId)) || 'the destination branch',
  };
}

export function listStockTransfers(auth: AuthContext, filters: DocumentListFilters) {
  return listDocuments(auth, DocumentType.STOCK_TRANSFER, filters);
}
