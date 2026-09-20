import {
  DocumentLinkType,
  DocumentStatus,
  DocumentType,
  InventoryTransactionType,
  Prisma,
  StockStatus,
} from '@prisma/client';
import { ZERO } from '../utils/decimal';

/**
 * Requirement fulfilment lives here rather than on either side of it, because
 * both receiving (which moves a requirement towards FULFILLED) and ordering
 * (which may only cover what is still short) need the same answer. One module is
 * also what keeps purchaseOrder and goodsReceipt from importing each other.
 *
 * The single rule: fulfilment is usable stock the requirement actually received
 * AT THE BRANCH THAT RAISED IT, through either of the two routes a requirement
 * may legitimately be met by - goods accepted from a supplier into that branch,
 * and stock received there from another branch on a transfer raised for this
 * requirement. Damaged and missing quantities, ordered but undelivered
 * quantities, dispatched but unreceived transfers, stock sitting at a different
 * branch and dispensing all sit outside it.
 */

/**
 * Quantity already claimed against a purchase order line across all its goods
 * receipts. Used to stop over-receiving.
 */
export async function getReceivedQuantitiesByLine(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string
): Promise<Map<string, Prisma.Decimal>> {
  const receiptLinks = await tx.documentLink.findMany({
    where: {
      targetDocumentId: purchaseOrderId,
      linkType: DocumentLinkType.RECEIVED_AGAINST,
    },
    select: { sourceDocumentId: true },
  });

  const totals = new Map<string, Prisma.Decimal>();
  if (receiptLinks.length === 0) {
    return totals;
  }

  const receiptLines = await tx.documentLineItem.findMany({
    where: {
      documentId: { in: receiptLinks.map((l) => l.sourceDocumentId) },
      document: { status: { not: DocumentStatus.CANCELLED } },
    },
    select: { referenceLineItemId: true, productId: true, quantity: true },
  });

  for (const line of receiptLines) {
    const key = line.referenceLineItemId ?? 'product:' + line.productId;
    totals.set(key, (totals.get(key) ?? ZERO).plus(line.quantity));
  }
  return totals;
}

/** Every purchase order raised to fulfil a requirement. */
export async function getPurchaseOrderIdsForRequirement(
  tx: Prisma.TransactionClient,
  requirementId: string
): Promise<string[]> {
  const links = await tx.documentLink.findMany({
    where: { targetDocumentId: requirementId, linkType: DocumentLinkType.FULFILLS },
    select: { sourceDocumentId: true },
  });
  return links.map((l) => l.sourceDocumentId);
}

/** Every requirement a purchase order was raised against. */
export async function getRequirementIdsForPurchaseOrder(
  tx: Prisma.TransactionClient,
  purchaseOrderId: string
): Promise<string[]> {
  const links = await tx.documentLink.findMany({
    where: { sourceDocumentId: purchaseOrderId, linkType: DocumentLinkType.FULFILLS },
    select: { targetDocumentId: true },
  });
  return links.map((l) => l.targetDocumentId);
}

/**
 * Usable quantity actually accepted against a set of purchase orders, per
 * product, taken from the stock ledger so receipt corrections are automatically
 * reflected: a correction posts signed deltas, so the sum is the live position
 * rather than what the receipt originally claimed.
 *
 * `branchId` is the branch the answer is being asked ON BEHALF OF, and it is not
 * optional information. Stock accepted at the central warehouse is stock the
 * company owns, but it is not stock Branch A has received: until it is
 * transferred and receipted there, Branch A's requirement is still outstanding.
 * Summing the ledger by product alone conflated the two and let a delivery into
 * central silently mark a branch requirement fulfilled - and, worse, closed the
 * shortfall the branch was entitled to re-order or have transferred.
 *
 * Pass `null` only when the question genuinely is company-wide, as it is when
 * valuing a supplier invoice: the supplier is owed for what was accepted from
 * them, wherever it landed.
 */
export async function getAcceptedUsableByProduct(
  tx: Prisma.TransactionClient,
  companyId: string,
  purchaseOrderIds: string[],
  branchId: string | null
): Promise<Map<string, Prisma.Decimal>> {
  const totals = new Map<string, Prisma.Decimal>();
  if (purchaseOrderIds.length === 0) {
    return totals;
  }

  const receiptLinks = await tx.documentLink.findMany({
    where: {
      targetDocumentId: { in: purchaseOrderIds },
      linkType: DocumentLinkType.RECEIVED_AGAINST,
    },
    select: { sourceDocumentId: true },
  });

  const receiptIds = receiptLinks.map((l) => l.sourceDocumentId);
  if (receiptIds.length === 0) {
    return totals;
  }

  const correctionLinks = await tx.documentLink.findMany({
    where: {
      targetDocumentId: { in: receiptIds },
      linkType: DocumentLinkType.CORRECTS,
    },
    select: { sourceDocumentId: true },
  });

  const documentIds = [...receiptIds, ...correctionLinks.map((l) => l.sourceDocumentId)];

  // Grouped by branch as well as product, and filtered to the asking branch when
  // one is given, so a movement that landed somewhere else cannot be counted.
  const grouped = await tx.inventoryTransaction.groupBy({
    by: ['productId', 'branchId'],
    where: {
      companyId,
      documentId: { in: documentIds },
      stockStatus: StockStatus.USABLE,
      ...(branchId ? { branchId } : {}),
    },
    _sum: { quantity: true },
  });

  for (const row of grouped) {
    totals.set(row.productId, (totals.get(row.productId) ?? ZERO).plus(row._sum.quantity ?? ZERO));
  }
  return totals;
}

/**
 * Accepted usable across every purchase order fulfilling the requirement. A
 * requirement split over several orders only reaches FULFILLED when they are
 * summed, so fulfilment is never derived from a single order.
 */
export async function getAcceptedUsableForRequirement(
  tx: Prisma.TransactionClient,
  companyId: string,
  requirementId: string
): Promise<Map<string, Prisma.Decimal>> {
  const requirement = await tx.document.findUnique({
    where: { id: requirementId },
    select: { companyId: true, branchId: true },
  });
  if (!requirement || requirement.companyId !== companyId) {
    return new Map<string, Prisma.Decimal>();
  }

  const purchaseOrderIds = await getPurchaseOrderIdsForRequirement(tx, requirementId);
  // The requesting branch, never the company: see getAcceptedUsableByProduct.
  return getAcceptedUsableByProduct(tx, companyId, purchaseOrderIds, requirement.branchId);
}

/**
 * Quantity the requirement's existing orders can still physically deliver, per
 * product: ordered less what their receipts already claimed. A line received in
 * full adds nothing back, however that receipt split into accepted, damaged and
 * missing - the shortfall is covered by a follow-up order, not by receiving the
 * closed one again.
 */
async function getOpenOrderedByProduct(
  tx: Prisma.TransactionClient,
  purchaseOrderIds: string[]
): Promise<Map<string, Prisma.Decimal>> {
  const totals = new Map<string, Prisma.Decimal>();
  if (purchaseOrderIds.length === 0) {
    return totals;
  }

  const orders = await tx.document.findMany({
    where: { id: { in: purchaseOrderIds }, status: { not: DocumentStatus.CANCELLED } },
    select: { id: true, lineItems: { select: { id: true, productId: true, quantity: true } } },
  });
  if (orders.length === 0) {
    return totals;
  }

  // Every order's receipts in one read, rather than a query per order.
  const receiptLinks = await tx.documentLink.findMany({
    where: {
      targetDocumentId: { in: orders.map((o) => o.id) },
      linkType: DocumentLinkType.RECEIVED_AGAINST,
    },
    select: { sourceDocumentId: true },
  });

  const claimedByOrderLine = new Map<string, Prisma.Decimal>();
  if (receiptLinks.length > 0) {
    const receiptLines = await tx.documentLineItem.findMany({
      where: {
        documentId: { in: receiptLinks.map((l) => l.sourceDocumentId) },
        document: { status: { not: DocumentStatus.CANCELLED } },
      },
      select: { referenceLineItemId: true, quantity: true },
    });
    for (const line of receiptLines) {
      if (!line.referenceLineItemId) {
        continue;
      }
      claimedByOrderLine.set(
        line.referenceLineItemId,
        (claimedByOrderLine.get(line.referenceLineItemId) ?? ZERO).plus(line.quantity)
      );
    }
  }

  for (const order of orders) {
    for (const line of order.lineItems) {
      const open = line.quantity.minus(claimedByOrderLine.get(line.id) ?? ZERO);
      if (open.greaterThan(0)) {
        totals.set(line.productId, (totals.get(line.productId) ?? ZERO).plus(open));
      }
    }
  }
  return totals;
}

/* --------------------------------------------------- internal transfers ---- */

/** Every stock transfer raised to fulfil a requirement. */
export async function getTransferIdsForRequirement(
  tx: Prisma.TransactionClient,
  requirementId: string
): Promise<string[]> {
  const links = await tx.documentLink.findMany({
    where: { targetDocumentId: requirementId, linkType: DocumentLinkType.TRANSFER_FOR },
    select: { sourceDocumentId: true },
  });
  return links.map((l) => l.sourceDocumentId);
}

/**
 * Usable quantity a requirement has actually received from other branches, per
 * product.
 *
 * Read from the ledger rather than from the transfer lines, and restricted to
 * TRANSFER_IN, which is the movement receipt posts at the destination. That one
 * filter is what makes dispatch non-fulfilling for free: a dispatched transfer
 * has written only its TRANSFER_OUT row, so it contributes nothing here until the
 * receiving branch accepts it. It also keeps the two legs from cancelling out,
 * which summing every USABLE row on the document would do.
 */
export interface TransferPosition {
  /** Usable quantity that has actually arrived, per product. */
  received: Map<string, Prisma.Decimal>;
  /** Quantity sent but not yet arrived, per product. */
  inTransit: Map<string, Prisma.Decimal>;
}

/**
 * Both halves of a requirement's transfer position, from one set of reads.
 *
 * Received and in-transit are the same three rows looked at twice - the linked
 * transfers, their lines, and the TRANSFER_IN movements against them - so asking
 * for them separately meant doing that work twice. Inside a transaction, where
 * every round trip is holding locks, that mattered.
 *
 * Received is read from the ledger rather than from the transfer lines, and
 * restricted to TRANSFER_IN, which is the movement receipt posts at the
 * destination. That one filter is what makes dispatch non-fulfilling for free: a
 * dispatched transfer has written only its TRANSFER_OUT row, so it contributes
 * nothing until the receiving branch accepts it. It also keeps the two legs from
 * cancelling out, which summing every USABLE row on the document would do.
 *
 * In-transit is the transfer twin of `getOpenOrderedByProduct`, and exists for
 * the same reason: stock on the road is spoken for. Without it a requirement with
 * 40 vials in transit would still permit a purchase order for the full 100, and
 * the branch would end up with 140.
 */
export async function getTransferPosition(
  tx: Prisma.TransactionClient,
  companyId: string,
  requirementId: string
): Promise<TransferPosition> {
  const received = new Map<string, Prisma.Decimal>();
  const inTransit = new Map<string, Prisma.Decimal>();

  const transferIds = await getTransferIdsForRequirement(tx, requirementId);
  if (transferIds.length === 0) {
    return { received, inTransit };
  }

  const [transfers, grouped] = await Promise.all([
    tx.document.findMany({
      where: { id: { in: transferIds }, status: { not: DocumentStatus.CANCELLED } },
      select: { id: true, lineItems: { select: { productId: true, quantity: true } } },
    }),
    tx.inventoryTransaction.groupBy({
      by: ['productId'],
      where: {
        companyId,
        documentId: { in: transferIds },
        transactionType: InventoryTransactionType.TRANSFER_IN,
        stockStatus: StockStatus.USABLE,
      },
      _sum: { quantity: true },
    }),
  ]);

  for (const row of grouped) {
    received.set(row.productId, row._sum.quantity ?? ZERO);
  }

  const sentByProduct = new Map<string, Prisma.Decimal>();
  for (const transfer of transfers) {
    for (const line of transfer.lineItems) {
      sentByProduct.set(
        line.productId,
        (sentByProduct.get(line.productId) ?? ZERO).plus(line.quantity)
      );
    }
  }

  // A received transfer cannot also be cancelled - RECEIVED is immutable - so the
  // received total above and this non-cancelled set describe the same documents.
  for (const [productId, sent] of sentByProduct) {
    const arrived = sent.minus(received.get(productId) ?? ZERO);
    if (arrived.greaterThan(0)) {
      inTransit.set(productId, arrived);
    }
  }

  return { received, inTransit };
}

/** Usable quantity a requirement has actually received from other branches. */
export async function getTransferReceivedByProduct(
  tx: Prisma.TransactionClient,
  companyId: string,
  requirementId: string
): Promise<Map<string, Prisma.Decimal>> {
  return (await getTransferPosition(tx, companyId, requirementId)).received;
}

/* ------------------------------------------------------ combined answer ---- */

/** Adds one per-product map into another, in place. */
function addInto(
  target: Map<string, Prisma.Decimal>,
  source: Map<string, Prisma.Decimal>
): Map<string, Prisma.Decimal> {
  for (const [productId, quantity] of source) {
    target.set(productId, (target.get(productId) ?? ZERO).plus(quantity));
  }
  return target;
}

/**
 * Everything a requirement has actually received, per product, from both routes.
 *
 * This is the figure the requirement status is decided from, and the single place
 * the two sources are summed: a requirement half met by a neighbouring branch and
 * half by a supplier reaches FULFILLED, and neither route alone can decide that.
 */
export async function getFulfilledByProduct(
  tx: Prisma.TransactionClient,
  companyId: string,
  requirementId: string
): Promise<Map<string, Prisma.Decimal>> {
  const procurement = await getAcceptedUsableForRequirement(tx, companyId, requirementId);
  const transfers = await getTransferReceivedByProduct(tx, companyId, requirementId);
  return addInto(new Map(procurement), transfers);
}

export interface RequirementRemaining {
  requested: Prisma.Decimal;
  /** Usable stock received, from procurement receipts and internal transfers. */
  accepted: Prisma.Decimal;
  /** Committed on purchase orders that can still deliver. */
  onOrder: Prisma.Decimal;
  /** Committed on transfers that have been raised but not yet received. */
  onTransfer: Prisma.Decimal;
  remaining: Prisma.Decimal;
}

/**
 * What may still be sourced against a requirement, per product, from anywhere:
 *
 *   remaining = requested
 *             - usable received (supplier receipts + internal transfers)
 *             - still open on its purchase orders
 *             - still in transit on its stock transfers
 *
 * `accepted` is the stock ledger AT THE REQUESTING BRANCH, never the claimed
 * receipt quantity and never the company-wide position. On REQ-0001 the supplier
 * claimed 100 and all 100 were received into the central warehouse, but the
 * correction left 70 usable there and only the 30 transferred on to Branch A and
 * receipted count as fulfilment of Branch A's requirement; deriving it from the
 * claimed quantity would wrongly answer 100, and ignoring the branch would
 * wrongly answer 70.
 *
 * The two committed-but-undelivered terms are what stop the same shortfall being
 * claimed twice. A requirement for 100 with 60 on an open order and 40 in transit
 * from another branch has nothing left to source, even though it has received
 * nothing at all yet - and a second purchase order for 60 is correctly refused.
 */
export async function getRemainingRequirementByProduct(
  tx: Prisma.TransactionClient,
  companyId: string,
  requirementId: string
): Promise<Map<string, RequirementRemaining>> {
  const requirement = await tx.document.findUnique({
    where: { id: requirementId },
    select: {
      companyId: true,
      branchId: true,
      lineItems: { select: { productId: true, quantity: true } },
    },
  });

  const result = new Map<string, RequirementRemaining>();
  if (!requirement || requirement.companyId !== companyId) {
    return result;
  }

  for (const line of requirement.lineItems) {
    const current = result.get(line.productId);
    result.set(line.productId, {
      requested: (current?.requested ?? ZERO).plus(line.quantity),
      accepted: ZERO,
      onOrder: ZERO,
      onTransfer: ZERO,
      remaining: ZERO,
    });
  }

  const purchaseOrderIds = await getPurchaseOrderIdsForRequirement(tx, requirementId);
  const procurementAccepted = await getAcceptedUsableByProduct(
    tx,
    companyId,
    purchaseOrderIds,
    requirement.branchId
  );
  // One read answers both transfer questions, rather than repeating the same
  // three queries for each of them.
  const transfers = await getTransferPosition(tx, companyId, requirementId);
  const accepted = addInto(new Map(procurementAccepted), transfers.received);
  const onOrder = await getOpenOrderedByProduct(tx, purchaseOrderIds);
  const onTransfer = transfers.inTransit;

  for (const [productId, row] of result) {
    const acceptedQty = accepted.get(productId) ?? ZERO;
    const onOrderQty = onOrder.get(productId) ?? ZERO;
    const onTransferQty = onTransfer.get(productId) ?? ZERO;
    const remaining = row.requested.minus(acceptedQty).minus(onOrderQty).minus(onTransferQty);
    result.set(productId, {
      requested: row.requested,
      accepted: acceptedQty,
      onOrder: onOrderQty,
      onTransfer: onTransferQty,
      remaining: remaining.greaterThan(0) ? remaining : ZERO,
    });
  }

  return result;
}

/* ---------------------------------------------- source branch own demand ---- */

/**
 * Requirement statuses that still represent demand a branch has not covered.
 *
 * The same two a transfer or a purchase order may be raised against: a draft or
 * submitted requirement is a proposal nobody has agreed to yet, and treating it
 * as a claim on a shelf would let an unapproved document quietly withhold stock
 * from a branch that genuinely needs it.
 */
const OPEN_REQUIREMENT_STATUSES: DocumentStatus[] = [
  DocumentStatus.APPROVED,
  DocumentStatus.PARTIALLY_FULFILLED,
];

/**
 * How many of a branch's own open requirements one demand scan will read.
 *
 * The scan is bounded because it is on a read path, and an unbounded one would
 * be hostage to how many requirements a busy branch happens to have open. The
 * bound is deliberately generous, and erring low is the safe direction: a
 * missed requirement understates the reserve, so more stock is offered as
 * surplus rather than less - it can never cause stock to be withheld wrongly.
 */
const DEMAND_SCAN_LIMIT = 200;

/** Key for the per-branch, per-product demand map. */
export function branchDemandKey(branchId: string, productId: string): string {
  return branchId + ':' + productId;
}

/**
 * What the branches holding stock still owe their OWN requirements, per product.
 *
 * This is the difference between stock being on a shelf and stock being spare.
 * Branch B with 50 vials and an approved requirement of its own for 20 is not
 * holding 50 spare: 20 of them are already answering a question somebody else
 * asked, and offering all 50 to another branch would solve one shortage by
 * creating another.
 *
 * It adds no arithmetic: each requirement's outstanding position comes from
 * `getRemainingRequirementByProduct`, the same engine the purchase order cap and
 * the availability view are built on, so a branch's own demand is measured
 * exactly as its fulfilment is - net of what it has received, what its open
 * orders will deliver and what is already in transit to it.
 *
 * The requirement being sourced is excluded, because it is the question being
 * asked rather than a competing claim on the answer.
 */
export async function getBranchOutstandingDemand(
  tx: Prisma.TransactionClient,
  companyId: string,
  scope: { branchIds: string[]; productIds: string[]; excludeRequirementId?: string }
): Promise<Map<string, Prisma.Decimal>> {
  const demand = new Map<string, Prisma.Decimal>();
  if (scope.branchIds.length === 0 || scope.productIds.length === 0) {
    return demand;
  }

  const requirements = await tx.document.findMany({
    take: DEMAND_SCAN_LIMIT,
    where: {
      companyId,
      documentType: DocumentType.STOCK_REQUIREMENT,
      status: { in: OPEN_REQUIREMENT_STATUSES },
      branchId: { in: scope.branchIds },
      ...(scope.excludeRequirementId ? { id: { not: scope.excludeRequirementId } } : {}),
      // Requirements for other products cannot reserve these ones, so they are
      // never read: a branch with fifty open requirements and none for this
      // product costs exactly one query here.
      lineItems: { some: { productId: { in: scope.productIds } } },
    },
    select: { id: true, branchId: true },
    orderBy: { documentDate: 'asc' },
  });
  if (requirements.length === 0) {
    return demand;
  }

  const wanted = new Set(scope.productIds);
  const positions = await Promise.all(
    requirements.map((requirement) =>
      getRemainingRequirementByProduct(tx, companyId, requirement.id)
    )
  );

  for (const [index, requirement] of requirements.entries()) {
    const branchId = requirement.branchId;
    if (!branchId) {
      continue;
    }
    for (const [productId, row] of positions[index]) {
      if (!wanted.has(productId) || !row.remaining.greaterThan(0)) {
        continue;
      }
      const key = branchDemandKey(branchId, productId);
      demand.set(key, (demand.get(key) ?? ZERO).plus(row.remaining));
    }
  }

  return demand;
}
