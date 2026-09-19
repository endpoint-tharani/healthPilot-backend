import { DocumentLinkType, DocumentStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma, Database } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { calculateLineTotals, money, ZERO } from '../utils/decimal';
import { Permission } from '../constants/permissions';
import {
  AvailabilityLine,
  RequirementAvailability,
  SurplusStatus,
  classifySurplus,
  getRequirementInternalAvailability,
} from './internalAvailability.service';

/**
 * The whole sourcing picture for a requirement, in one read: what the company
 * already holds elsewhere, and what it would cost to buy the rest.
 *
 * This module adds no arithmetic of its own to the two questions that already
 * have an owner. Internal stock and the fulfilment position come from
 * `getRequirementInternalAvailability`, which is the authoritative engine; this
 * regroups that answer by branch and adds the procurement half beside it.
 *
 * Nothing here is a recommendation. The supplier rows are facts about what this
 * company actually paid and actually waited, laid side by side so a buyer can
 * choose. The ERP does not rank them, does not mark one preferred, and does not
 * know what any supplier currently has on a shelf.
 *
 * The surplus classification on each line is the procurement guardrail: before
 * anybody raises a purchase order, it says in one word whether the company could
 * have covered the shortfall from its own shelves. It suggests; it never blocks,
 * never chooses and never creates a document.
 */

/* --------------------------------------------------- supplier comparison ---- */

/**
 * Where a supplier's price came from.
 *
 * LAST_PURCHASE is what this supplier last charged for this product on a real
 * purchase order. PRODUCT_MASTER is the list price, used when this supplier has
 * never supplied this product - it is what an order would default to today, not
 * a quote anyone has given.
 */
export type PriceSource = 'LAST_PURCHASE' | 'PRODUCT_MASTER';

/** How far back the price and lead-time scan reaches, in purchase order lines. */
const HISTORY_SCAN_LIMIT = 500;

export interface SupplierOption {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  unitPrice: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  estimatedSubtotal: Prisma.Decimal;
  estimatedTax: Prisma.Decimal;
  estimatedTotal: Prisma.Decimal;
  /** Mean days from order to first receipt, observed. Null when never supplied. */
  leadTimeDays: number | null;
  priceSource: PriceSource;
  lastPurchasedAt: Date | null;
  /** How many completed orders the lead time was averaged over. */
  leadTimeSampleSize: number;
}

interface SupplierHistory {
  unitPrice: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  documentDate: Date;
  leadTimeDays: number | null;
  leadTimeSampleSize: number;
}

/**
 * What every supplier in the company has historically charged for these products,
 * and how long they took.
 *
 * Read from purchase orders and their receipts, because that is the only supplier
 * commercial data this ERP holds - there is no supplier price list and no lead
 * time field. A supplier that has never supplied a product simply has no history,
 * and is reported as such rather than being given invented numbers.
 *
 * Lead time is the gap between a purchase order and the first goods receipt
 * against it, averaged over that supplier's orders for the product. It describes
 * what happened, not what anyone promised.
 */
async function getSupplierHistory(
  db: Database,
  companyId: string,
  productIds: string[]
): Promise<Map<string, SupplierHistory>> {
  const history = new Map<string, SupplierHistory>();
  if (productIds.length === 0) {
    return history;
  }

  const orderLines = await db.documentLineItem.findMany({
    // Newest first and bounded: the latest price is the first row seen for a
    // supplier, and lead time is an average, so neither needs the whole history
    // of a product that has been bought hundreds of times. A supplier whose last
    // order falls outside the window is reported on the product master price,
    // which is what an order would default to anyway.
    take: HISTORY_SCAN_LIMIT,
    where: {
      productId: { in: productIds },
      document: {
        companyId,
        documentType: DocumentType.PURCHASE_ORDER,
        status: { not: DocumentStatus.CANCELLED },
        supplierId: { not: null },
      },
    },
    select: {
      productId: true,
      unitPrice: true,
      taxRate: true,
      document: { select: { id: true, supplierId: true, documentDate: true } },
    },
    orderBy: { document: { documentDate: 'desc' } },
  });

  if (orderLines.length === 0) {
    return history;
  }

  // First receipt against each order, which is where the observed lead time ends.
  const receiptLinks = await db.documentLink.findMany({
    where: {
      targetDocumentId: { in: [...new Set(orderLines.map((line) => line.document.id))] },
      linkType: DocumentLinkType.RECEIVED_AGAINST,
    },
    select: {
      targetDocumentId: true,
      sourceDocument: { select: { documentDate: true, status: true } },
    },
  });

  const firstReceiptByOrder = new Map<string, Date>();
  for (const link of receiptLinks) {
    if (link.sourceDocument.status === DocumentStatus.CANCELLED) {
      continue;
    }
    const current = firstReceiptByOrder.get(link.targetDocumentId);
    const candidate = link.sourceDocument.documentDate;
    if (!current || candidate < current) {
      firstReceiptByOrder.set(link.targetDocumentId, candidate);
    }
  }

  const leadTimes = new Map<string, number[]>();

  for (const line of orderLines) {
    const supplierId = line.document.supplierId;
    if (!supplierId) {
      continue;
    }
    const key = supplierId + ':' + line.productId;

    // Lines arrive newest first, so the first one seen is the latest price.
    if (!history.has(key)) {
      history.set(key, {
        unitPrice: line.unitPrice,
        taxRate: line.taxRate,
        documentDate: line.document.documentDate,
        leadTimeDays: null,
        leadTimeSampleSize: 0,
      });
    }

    const receivedOn = firstReceiptByOrder.get(line.document.id);
    if (receivedOn) {
      const days = Math.max(
        0,
        Math.round(
          (receivedOn.getTime() - line.document.documentDate.getTime()) / (24 * 60 * 60 * 1000)
        )
      );
      leadTimes.set(key, [...(leadTimes.get(key) ?? []), days]);
    }
  }

  for (const [key, samples] of leadTimes) {
    const entry = history.get(key);
    if (!entry || samples.length === 0) {
      continue;
    }
    entry.leadTimeDays = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
    entry.leadTimeSampleSize = samples.length;
  }

  return history;
}

/**
 * Every supplier that could be asked for this product, priced for the quantity
 * actually still needed.
 *
 * Every supplier in the company is listed. Having no history is not a reason to
 * hide one - it is a fact about that supplier, shown as such - and excluding them
 * would quietly narrow the buyer's options to whoever happens to have been used
 * before.
 *
 * Money is computed with the same `calculateLineTotals` a purchase order uses, so
 * the estimate on this screen is what the order will actually total.
 */
function supplierOptionsFor(
  suppliers: { id: string; code: string; name: string }[],
  history: Map<string, SupplierHistory>,
  productId: string,
  fallbackPrice: Prisma.Decimal,
  fallbackTaxRate: Prisma.Decimal,
  quantity: Prisma.Decimal
): SupplierOption[] {
  return suppliers.map((supplier) => {
    const known = history.get(supplier.id + ':' + productId);
    const unitPrice = known?.unitPrice ?? fallbackPrice;
    const taxRate = known?.taxRate ?? fallbackTaxRate;
    const totals = calculateLineTotals(quantity, unitPrice, taxRate);

    return {
      supplierId: supplier.id,
      supplierCode: supplier.code,
      supplierName: supplier.name,
      unitPrice: money(unitPrice),
      taxRate: money(taxRate),
      estimatedSubtotal: totals.subtotal,
      estimatedTax: totals.taxAmount,
      estimatedTotal: totals.total,
      leadTimeDays: known?.leadTimeDays ?? null,
      priceSource: known ? 'LAST_PURCHASE' : 'PRODUCT_MASTER',
      lastPurchasedAt: known?.documentDate ?? null,
      leadTimeSampleSize: known?.leadTimeSampleSize ?? 0,
    };
  });
}

/* ------------------------------------------------------ internal sources ---- */

export interface SourcingBatch {
  batchId: string;
  batchNumber: string;
  expiryDate: Date;
  availableQty: Prisma.Decimal;
  /** Of that, what this branch could genuinely spare. */
  surplusQty: Prisma.Decimal;
  /** The backend proposal for this batch, already capped at what is needed. */
  suggestedQty: Prisma.Decimal;
  unitCost: Prisma.Decimal;
  /** Factual flag: this is the earliest-expiring stock offered for the product. */
  expiresSoonest: boolean;
}

export interface SourcingBranch {
  branchId: string;
  branchCode: string;
  branchName: string;
  branchType: string;
  totalAvailableQty: Prisma.Decimal;
  /** What this branch could spare: on hand, less its own outstanding demand. */
  sourceableSurplusQty: Prisma.Decimal;
  /** On-hand quantity this branch is keeping for its own requirements. */
  reservedQty: Prisma.Decimal;
  /** This branch's surplus against the requirement's outstanding quantity. */
  surplusStatus: SurplusStatus;
  totalSuggestedQty: Prisma.Decimal;
  batches: SourcingBatch[];
}

export interface SourcingProductLine {
  productId: string;
  product: { id: string; code: string; name: string; unit: string };
  requestedQty: Prisma.Decimal;
  fulfilledQty: Prisma.Decimal;
  remainingQty: Prisma.Decimal;
  internal: {
    /** Surplus credited to this line, capped at what it still needs. */
    totalSourceableQty: Prisma.Decimal;
    /** Surplus across every source branch, before that cap. */
    totalSurplusQty: Prisma.Decimal;
    /** On-hand quantity the source branches are keeping for themselves. */
    reservedQty: Prisma.Decimal;
    surplusStatus: SurplusStatus;
    sources: SourcingBranch[];
    withheldQty: Prisma.Decimal;
    withheldBranchCount: number;
  };
  procurement: {
    requiredQty: Prisma.Decimal;
    suppliers: SupplierOption[];
    /** True when the caller may not see supplier commercial detail. */
    comparisonRestricted: boolean;
  };
  sourcingSummary: {
    internalAvailableQty: Prisma.Decimal;
    procurementRequiredQty: Prisma.Decimal;
    onTransferQty: Prisma.Decimal;
    onOrderQty: Prisma.Decimal;
    remainingQty: Prisma.Decimal;
  };
}

export interface RequirementSourcingAnalysis {
  requirement: RequirementAvailability['requirement'];
  productLines: SourcingProductLine[];
  totals: RequirementAvailability['totals'];
  /** The whole requirement's surplus position, for the procurement guardrail. */
  surplusStatus: SurplusStatus;
  detailRestricted: boolean;
  canCreateTransfer: boolean;
  canCreatePurchaseOrder: boolean;
}

/**
 * The availability answer, regrouped so each branch owns its batches.
 *
 * `outstanding` is passed in only to classify each branch's surplus against what
 * the requirement actually still needs; no quantity is recomputed here.
 */
function groupByBranch(line: AvailabilityLine, outstanding: Prisma.Decimal): SourcingBranch[] {
  const earliestExpiry = line.sources.reduce<number | null>((earliest, source) => {
    const time = source.batch.expiryDate.getTime();
    return earliest === null || time < earliest ? time : earliest;
  }, null);

  const byBranch = new Map<string, SourcingBranch>();

  for (const source of line.sources) {
    const existing = byBranch.get(source.branch.id) ?? {
      branchId: source.branch.id,
      branchCode: source.branch.code,
      branchName: source.branch.name,
      branchType: source.branch.type,
      totalAvailableQty: ZERO,
      sourceableSurplusQty: ZERO,
      reservedQty: ZERO,
      surplusStatus: 'NO_SURPLUS' as SurplusStatus,
      totalSuggestedQty: ZERO,
      batches: [],
    };

    existing.batches.push({
      batchId: source.batch.id,
      batchNumber: source.batch.batchNumber,
      expiryDate: source.batch.expiryDate,
      availableQty: source.available,
      surplusQty: source.surplus,
      suggestedQty: source.suggested,
      unitCost: source.unitCost,
      expiresSoonest: source.batch.expiryDate.getTime() === earliestExpiry,
    });
    existing.totalAvailableQty = existing.totalAvailableQty.plus(source.available);
    existing.sourceableSurplusQty = existing.sourceableSurplusQty.plus(source.surplus);
    existing.totalSuggestedQty = existing.totalSuggestedQty.plus(source.suggested);

    byBranch.set(source.branch.id, existing);
  }

  for (const branch of byBranch.values()) {
    branch.reservedQty = branch.totalAvailableQty.minus(branch.sourceableSurplusQty);
    branch.surplusStatus = classifySurplus(branch.sourceableSurplusQty, outstanding);
  }

  // Shortest shelf life first within a branch, matching the order the allocation
  // proposal itself walked, so the screen reads in the order it was decided.
  for (const branch of byBranch.values()) {
    branch.batches.sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime());
  }

  return [...byBranch.values()].sort((a, b) => a.branchCode.localeCompare(b.branchCode));
}

/**
 * Internal stock and supplier options for one requirement, side by side.
 *
 * Read-only: it creates no document, moves no stock and reserves nothing. The
 * quantities it reports are a live read that another branch can invalidate a
 * second later, which is why transfer creation re-checks everything under lock
 * rather than trusting what this returned.
 */
export async function getRequirementSourcingAnalysis(
  auth: AuthContext,
  requirementId: string,
  db: Database = prisma
): Promise<RequirementSourcingAnalysis> {
  // The single fulfilment and availability engine. Company scope, branch scope,
  // expiry, committed stock and the outstanding position are all decided there.
  const availability = await getRequirementInternalAvailability(auth, requirementId, db);

  /**
   * Supplier prices and lead times are commercial procurement detail, so they
   * follow the permission that lets somebody act on them. A branch pharmacist is
   * still told how much needs procuring - that is their requirement - but what it
   * would cost from whom is the buyer's business, on the same reasoning that
   * keeps another branch's shelf out of their view.
   */
  const canCompareSuppliers = auth.permissions.includes(Permission.PURCHASE_ORDER_CREATE);

  const productIds = availability.lines.map((line) => line.productId);

  // Two round trips that buy nothing when the requirement is fully covered
  // internally: there is no shortfall to price, so no supplier list and no
  // purchase history are read at all.
  const needsProcurement = availability.lines.some((line) =>
    line.procurementShortfall.greaterThan(0)
  );
  const compareSuppliers = canCompareSuppliers && needsProcurement;

  const [suppliers, products, history] = await Promise.all([
    compareSuppliers
      ? db.supplier.findMany({
          where: { companyId: auth.companyId, isActive: true },
          select: { id: true, code: true, name: true },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([] as { id: string; code: string; name: string }[]),
    productIds.length
      ? db.product.findMany({
          where: { id: { in: productIds }, companyId: auth.companyId },
          select: { id: true, purchasePrice: true, taxRate: true },
        })
      : Promise.resolve([] as { id: string; purchasePrice: Prisma.Decimal; taxRate: Prisma.Decimal }[]),
    compareSuppliers
      ? getSupplierHistory(db, auth.companyId, productIds)
      : Promise.resolve(new Map<string, SupplierHistory>()),
  ]);

  const productById = new Map(products.map((product) => [product.id, product]));

  const productLines: SourcingProductLine[] = availability.lines.map((line) => {
    const master = productById.get(line.productId);
    const requiredQty = line.procurementShortfall;

    return {
      productId: line.productId,
      product: line.product,
      requestedQty: line.requested,
      fulfilledQty: line.fulfilled,
      remainingQty: line.outstanding,
      internal: {
        totalSourceableQty: line.internalAvailable,
        totalSurplusQty: line.internalSurplus,
        reservedQty: line.reservedBySourceBranches,
        surplusStatus: line.surplusStatus,
        sources: groupByBranch(line, line.outstanding),
        withheldQty: line.withheldQuantity,
        withheldBranchCount: line.withheldBranchCount,
      },
      procurement: {
        requiredQty,
        // Priced for the quantity actually still needed, so the estimate is the
        // order somebody would really place rather than a unit-price table.
        suppliers:
          compareSuppliers && requiredQty.greaterThan(0)
            ? supplierOptionsFor(
                suppliers,
                history,
                line.productId,
                master?.purchasePrice ?? ZERO,
                master?.taxRate ?? ZERO,
                requiredQty
              )
            : [],
        comparisonRestricted: !canCompareSuppliers,
      },
      sourcingSummary: {
        internalAvailableQty: line.internalAvailable,
        procurementRequiredQty: requiredQty,
        onTransferQty: line.onTransfer,
        onOrderQty: line.onOrder,
        remainingQty: line.outstanding,
      },
    };
  });

  return {
    requirement: availability.requirement,
    productLines,
    totals: availability.totals,
    surplusStatus: availability.surplusStatus,
    detailRestricted: availability.detailRestricted,
    canCreateTransfer: availability.canCreateTransfer,
    canCreatePurchaseOrder: canCompareSuppliers,
  };
}

/** Wire shape: Decimals become fixed-2 strings, as every other document does. */
export function serializeSourcingAnalysis(result: RequirementSourcingAnalysis) {
  const qty = (value: Prisma.Decimal) => value.toFixed(2);

  return {
    requirement: result.requirement,
    detailRestricted: result.detailRestricted,
    canCreateTransfer: result.canCreateTransfer,
    canCreatePurchaseOrder: result.canCreatePurchaseOrder,
    surplusStatus: result.surplusStatus,
    totals: {
      requested: qty(result.totals.requested),
      fulfilled: qty(result.totals.fulfilled),
      outstanding: qty(result.totals.outstanding),
      internalAvailable: qty(result.totals.internalAvailable),
      procurementShortfall: qty(result.totals.procurementShortfall),
      internalSurplus: qty(result.totals.internalSurplus),
      reservedBySourceBranches: qty(result.totals.reservedBySourceBranches),
      // The same two numbers above, named for the decision they support.
      suggestedInternalQty: qty(result.totals.internalAvailable),
      suggestedProcurementQty: qty(result.totals.procurementShortfall),
    },
    productLines: result.productLines.map((line) => ({
      product: line.product,
      requestedQty: qty(line.requestedQty),
      fulfilledQty: qty(line.fulfilledQty),
      remainingQty: qty(line.remainingQty),
      internal: {
        totalSourceableQty: qty(line.internal.totalSourceableQty),
        totalSurplusQty: qty(line.internal.totalSurplusQty),
        reservedQty: qty(line.internal.reservedQty),
        surplusStatus: line.internal.surplusStatus,
        suggestedInternalQty: qty(line.internal.totalSourceableQty),
        suggestedProcurementQty: qty(line.procurement.requiredQty),
        withheldQty: qty(line.internal.withheldQty),
        withheldBranchCount: line.internal.withheldBranchCount,
        sources: line.internal.sources.map((branch) => ({
          branchId: branch.branchId,
          branchCode: branch.branchCode,
          branchName: branch.branchName,
          branchType: branch.branchType,
          totalAvailableQty: qty(branch.totalAvailableQty),
          sourceableSurplusQty: qty(branch.sourceableSurplusQty),
          reservedQty: qty(branch.reservedQty),
          surplusStatus: branch.surplusStatus,
          totalSuggestedQty: qty(branch.totalSuggestedQty),
          batches: branch.batches.map((batch) => ({
            batchId: batch.batchId,
            batchNumber: batch.batchNumber,
            expiryDate: batch.expiryDate,
            availableQty: qty(batch.availableQty),
            surplusQty: qty(batch.surplusQty),
            suggestedQty: qty(batch.suggestedQty),
            unitCost: qty(batch.unitCost),
            expiresSoonest: batch.expiresSoonest,
          })),
        })),
      },
      procurement: {
        requiredQty: qty(line.procurement.requiredQty),
        comparisonRestricted: line.procurement.comparisonRestricted,
        suppliers: line.procurement.suppliers.map((supplier) => ({
          supplierId: supplier.supplierId,
          supplierCode: supplier.supplierCode,
          supplierName: supplier.supplierName,
          unitPrice: qty(supplier.unitPrice),
          taxRate: qty(supplier.taxRate),
          estimatedSubtotal: qty(supplier.estimatedSubtotal),
          estimatedTax: qty(supplier.estimatedTax),
          estimatedTotal: qty(supplier.estimatedTotal),
          leadTimeDays: supplier.leadTimeDays,
          leadTimeSampleSize: supplier.leadTimeSampleSize,
          priceSource: supplier.priceSource,
          lastPurchasedAt: supplier.lastPurchasedAt,
        })),
      },
      sourcingSummary: {
        internalAvailableQty: qty(line.sourcingSummary.internalAvailableQty),
        procurementRequiredQty: qty(line.sourcingSummary.procurementRequiredQty),
        onTransferQty: qty(line.sourcingSummary.onTransferQty),
        onOrderQty: qty(line.sourcingSummary.onOrderQty),
        remainingQty: qty(line.sourcingSummary.remainingQty),
      },
    })),
  };
}
