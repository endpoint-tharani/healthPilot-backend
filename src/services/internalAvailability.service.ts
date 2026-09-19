import { DocumentStatus, DocumentType, Prisma, StockStatus } from '@prisma/client';
import { prisma, Database } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { notFound } from '../utils/errors';
import { ZERO } from '../utils/decimal';
import { Permission } from '../constants/permissions';
import { assertDocumentReadAccess, isBranchInScope } from './authorization.service';
import { SourceableBucket, getSourceableStock } from './inventory.service';
import {
  branchDemandKey,
  getBranchOutstandingDemand,
  getRemainingRequirementByProduct,
} from './fulfilment.service';

/**
 * Whether a requirement can be met from stock the company already owns, before
 * anybody raises a purchase order.
 *
 * This module only ever reads. Checking availability moves no stock and creates
 * no document: it answers what could be sourced internally, and the transfer that
 * acts on the answer is raised separately and re-validates the position under
 * lock, because an answer given to a screen is stale the moment another branch
 * dispatches.
 *
 * Availability is deliberately not the same question as fulfilment. Fulfilment is
 * what a requirement has actually received; availability is what is sitting on a
 * shelf somewhere else and could be sent.
 */

/**
 * Stock is only offered as a source when it could genuinely be dispensed at the
 * far end, which is the rule dispensing already enforces: a usable batch that has
 * not expired. A branch is never asked to send stock the receiving branch would
 * have to write off on arrival.
 */
function sourceableBatchWhere(): Prisma.BatchWhereInput {
  return { status: StockStatus.USABLE, expiryDate: { gt: new Date() } };
}

/**
 * How much of a requirement the stock a branch can genuinely spare would cover.
 *
 * The classification exists because "there is stock somewhere" is not a decision
 * a buyer can act on, and "usable stock >= what we need" is the wrong test: a
 * branch holding 50 with 20 promised to another transfer and 20 owed to its own
 * approved requirement can spare 10, not 50. These three answers are always
 * measured against the sourceable SURPLUS, never against stock on hand.
 */
export type SurplusStatus = 'HIGH_SURPLUS' | 'PARTIAL_SURPLUS' | 'NO_SURPLUS';

/**
 * A requirement that needs nothing is NO_SURPLUS rather than HIGH_SURPLUS, even
 * when a neighbouring branch is sitting on a hundred spare vials. The question
 * this answers is "how much of what we still need could come from inside", and
 * when the answer to "what do we still need" is nothing, there is no sourcing
 * opportunity to report - calling it HIGH_SURPLUS would have every settled
 * requirement in the company advertising a transfer nobody should raise.
 */
export function classifySurplus(
  surplus: Prisma.Decimal,
  required: Prisma.Decimal
): SurplusStatus {
  if (surplus.lessThanOrEqualTo(0) || required.lessThanOrEqualTo(0)) {
    return 'NO_SURPLUS';
  }
  return surplus.greaterThanOrEqualTo(required) ? 'HIGH_SURPLUS' : 'PARTIAL_SURPLUS';
}

/** Bucket identity within one availability read. */
function surplusKey(bucket: { branchId: string; productId: string; batchId: string }): string {
  return [bucket.branchId, bucket.productId, bucket.batchId].join(':');
}

/**
 * How much of each bucket the branch holding it could genuinely spare.
 *
 * `getSourceableStock` has already taken off what other transfers have claimed;
 * what it cannot know is that the holding branch has an approved requirement of
 * its own still waiting. That last subtraction happens here, from the demand the
 * fulfilment engine reports, and it is the difference between stock being on a
 * shelf and stock being spare.
 *
 * The reserve is absorbed by the longest-dated batches first, so what a branch
 * keeps back for itself is its freshest stock and what it offers is the stock
 * closest to expiry. That is the outcome the business wants either way - short-
 * dated stock should move to where it will actually be used - and it leaves the
 * earliest-expiring batches at the top of the suggestion, which is the order the
 * rest of this module already proposes sourcing in.
 */
function surplusByBucket(
  buckets: SourceableBucket[],
  expiryOf: (bucket: SourceableBucket) => number,
  demand: Map<string, Prisma.Decimal>
): Map<string, Prisma.Decimal> {
  const surplus = new Map<string, Prisma.Decimal>();

  const byHolding = new Map<string, SourceableBucket[]>();
  for (const bucket of buckets) {
    const key = branchDemandKey(bucket.branchId, bucket.productId);
    byHolding.set(key, [...(byHolding.get(key) ?? []), bucket]);
  }

  for (const [key, group] of byHolding) {
    let reserve = demand.get(key) ?? ZERO;
    for (const bucket of [...group].sort((a, b) => expiryOf(b) - expiryOf(a))) {
      const held =
        reserve.greaterThan(0)
          ? reserve.lessThan(bucket.available)
            ? reserve
            : bucket.available
          : ZERO;
      reserve = reserve.minus(held);
      surplus.set(surplusKey(bucket), bucket.available.minus(held));
    }
  }

  return surplus;
}

export interface AvailabilitySource {
  branch: { id: string; code: string; name: string; type: string };
  batch: { id: string; batchNumber: string; expiryDate: Date };
  /** Usable quantity on hand in this bucket right now, net of other transfers. */
  available: Prisma.Decimal;
  /**
   * Of that, what the holding branch could genuinely spare: available less what
   * it still owes its own approved requirements. This, never `available`, is
   * what the suggestion and the surplus classification are measured from.
   */
  surplus: Prisma.Decimal;
  /** Capped at what the requirement still needs, so a plan never over-sources. */
  suggested: Prisma.Decimal;
  /** Weighted average ledger cost of the bucket; what a transfer would carry. */
  unitCost: Prisma.Decimal;
}

export interface AvailabilityLine {
  productId: string;
  product: { id: string; code: string; name: string; unit: string };
  requested: Prisma.Decimal;
  /** Usable stock already received, from procurement and internal transfers alike. */
  fulfilled: Prisma.Decimal;
  /** Already committed but not yet received: open purchase orders. */
  onOrder: Prisma.Decimal;
  /** Already committed but not yet received: transfers raised for this requirement. */
  onTransfer: Prisma.Decimal;
  /** What still has to be found from somewhere. */
  outstanding: Prisma.Decimal;
  /**
   * Of the outstanding quantity, what internal SURPLUS could cover. This is the
   * suggested internal quantity: it is capped at what is still outstanding, so a
   * branch holding 500 spare vials does not make a 10-vial requirement 500
   * fulfillable.
   */
  internalAvailable: Prisma.Decimal;
  /** Of the outstanding quantity, what only a supplier can cover. */
  procurementShortfall: Prisma.Decimal;
  /** Total sourceable surplus across every source branch, before that cap. */
  internalSurplus: Prisma.Decimal;
  /** On-hand quantity held back for the source branches' own requirements. */
  reservedBySourceBranches: Prisma.Decimal;
  /** The surplus against this line's own outstanding quantity. */
  surplusStatus: SurplusStatus;
  /** Buckets the caller is allowed to see, shortest shelf life first. */
  sources: AvailabilitySource[];
  /**
   * Quantity counted in the internal total that sits at a branch this caller may
   * not inspect. The total stays honest; the breakdown is withheld.
   */
  withheldQuantity: Prisma.Decimal;
  withheldBranchCount: number;
}

export interface RequirementAvailability {
  requirement: {
    id: string;
    documentNumber: string;
    status: DocumentStatus;
    branch: { id: string; code: string; name: string } | null;
  };
  lines: AvailabilityLine[];
  totals: {
    requested: Prisma.Decimal;
    fulfilled: Prisma.Decimal;
    outstanding: Prisma.Decimal;
    internalAvailable: Prisma.Decimal;
    procurementShortfall: Prisma.Decimal;
    internalSurplus: Prisma.Decimal;
    reservedBySourceBranches: Prisma.Decimal;
  };
  /**
   * The whole requirement's position, decided from the capped per-line figures:
   * HIGH_SURPLUS only when internal stock could cover every outstanding line.
   */
  surplusStatus: SurplusStatus;
  /** True when the caller sees only totals for at least one branch. */
  detailRestricted: boolean;
  /** True when the caller could act on this plan by raising a transfer. */
  canCreateTransfer: boolean;
}

/**
 * Who may see WHERE the stock is, as opposed to merely that it exists.
 *
 * A branch pharmacist is told that 50 units are available internally, so they
 * know a purchase order is not the only option, but the branch-by-branch
 * breakdown is procurement business: it is the people who can actually raise the
 * transfer who need to know which branch to take it from. That is exactly the set
 * holding STOCK_TRANSFER_CREATE, so the permission granting the action also
 * grants the detail behind it - no new permission, and no widening of one.
 *
 * Branches already inside the caller scope stay visible either way, because those
 * rows are readable from the stock report today. Nothing here exposes a bucket
 * the caller could not already reach.
 */
function canSeeSource(auth: AuthContext, branchId: string): boolean {
  return (
    auth.permissions.includes(Permission.STOCK_TRANSFER_CREATE) || isBranchInScope(auth, branchId)
  );
}

/**
 * The sourcing picture for one requirement: what it still needs, what the rest of
 * the company is holding, and what is therefore left for a supplier.
 *
 * Suggested quantities are a proposal only. Nothing is reserved - two people
 * looking at the same screen are both told the stock is there, and the first
 * transfer to be raised wins at the ledger.
 */
export async function getRequirementInternalAvailability(
  auth: AuthContext,
  requirementId: string,
  db: Database = prisma
): Promise<RequirementAvailability> {
  const requirement = await db.document.findUnique({
    where: { id: requirementId },
    include: {
      branch: { select: { id: true, code: true, name: true } },
      lineItems: {
        orderBy: { lineNumber: 'asc' },
        include: { product: { select: { id: true, code: true, name: true, unit: true } } },
      },
    },
  });

  if (!requirement || requirement.documentType !== DocumentType.STOCK_REQUIREMENT) {
    throw notFound('Stock requirement not found');
  }
  // Company isolation and branch scope, on the same rule every document read uses.
  assertDocumentReadAccess(auth, requirement);

  // The outstanding position comes from the procurement module rather than being
  // recomputed here, so availability can never disagree with the cap the purchase
  // order path enforces.
  const remaining = await getRemainingRequirementByProduct(
    db as Prisma.TransactionClient,
    auth.companyId,
    requirementId
  );

  const productIds = [...new Set(requirement.lineItems.map((line) => line.productId))];

  // A branch cannot source from itself: stock already at the requesting branch is
  // not a transfer, and counting it would invent availability that changes nothing.
  // Net of transfers already raised out of the same buckets, so the sourcing view
  // never offers stock that has been promised to another requirement - the number
  // shown here is the number transfer creation will actually allow.
  const buckets = productIds.length
    ? await getSourceableStock(
        db,
        {
          companyId: auth.companyId,
          stockStatus: StockStatus.USABLE,
          productId: { in: productIds },
          ...(requirement.branchId ? { branchId: { not: requirement.branchId } } : {}),
          batch: sourceableBatchWhere(),
        },
        { companyId: auth.companyId, productIds }
      )
    : [];

  /**
   * `ownDemand` is what the branches holding this stock still owe their own
   * approved requirements. Without it the sourcing view would answer "Branch B
   * has 50, so it can send 10" while Branch B is itself 20 short - solving one
   * shortage by creating another. The figure comes from the fulfilment engine,
   * so a branch's own demand is measured exactly the way its fulfilment is.
   *
   * It rides alongside the branch and batch reads rather than after them: it
   * depends only on which branches hold stock, which is already known, so the
   * guardrail costs this endpoint no extra round trip in sequence. Nothing is
   * read at all when no branch holds any of these products, which is the common
   * case for a requirement that has to be procured.
   */
  const [branches, batches, ownDemand] = await Promise.all([
    db.branch.findMany({
      where: { companyId: auth.companyId, isActive: true },
      select: { id: true, code: true, name: true, type: true },
    }),
    buckets.length
      ? db.batch.findMany({
          where: { id: { in: [...new Set(buckets.map((bucket) => bucket.batchId))] } },
          select: { id: true, batchNumber: true, expiryDate: true },
        })
      : Promise.resolve([] as { id: string; batchNumber: string; expiryDate: Date }[]),
    buckets.length
      ? getBranchOutstandingDemand(db as Prisma.TransactionClient, auth.companyId, {
          branchIds: [...new Set(buckets.map((bucket) => bucket.branchId))],
          productIds,
          excludeRequirementId: requirementId,
        })
      : Promise.resolve(new Map<string, Prisma.Decimal>()),
  ]);

  const branchById = new Map(branches.map((branch) => [branch.id, branch]));
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));

  const surplusOf = surplusByBucket(
    buckets,
    (bucket) => batchById.get(bucket.batchId)?.expiryDate?.getTime() ?? 0,
    ownDemand
  );

  const bucketsByProduct = new Map<string, typeof buckets>();
  for (const bucket of buckets) {
    // An inactive branch is not somewhere stock can be sent from.
    if (!branchById.has(bucket.branchId)) {
      continue;
    }
    const list = bucketsByProduct.get(bucket.productId) ?? [];
    list.push(bucket);
    bucketsByProduct.set(bucket.productId, list);
  }

  const lines: AvailabilityLine[] = [];
  const seen = new Set<string>();

  for (const item of requirement.lineItems) {
    // Two requirement lines for one product share a single outstanding position,
    // so they are answered once rather than each claiming the whole of it.
    if (seen.has(item.productId)) {
      continue;
    }
    seen.add(item.productId);

    const position = remaining.get(item.productId);
    const requested = position?.requested ?? item.quantity;
    const fulfilled = position?.accepted ?? ZERO;
    const onOrder = position?.onOrder ?? ZERO;
    const onTransfer = position?.onTransfer ?? ZERO;
    const outstanding = position?.remaining ?? requested;

    // Shortest shelf life first: sourcing the batch that expires soonest is what
    // stops usable stock ageing out in one branch while another orders new stock.
    const candidates = (bucketsByProduct.get(item.productId) ?? []).sort((a, b) => {
      const left = batchById.get(a.batchId)?.expiryDate?.getTime() ?? 0;
      const right = batchById.get(b.batchId)?.expiryDate?.getTime() ?? 0;
      return left - right;
    });

    let onHandTotal = ZERO;
    let internalSurplus = ZERO;
    let withheldQuantity = ZERO;
    const withheldBranches = new Set<string>();
    const sources: AvailabilitySource[] = [];

    // Allocation walks the candidates in the order the UI shows them, so the
    // suggested plan on screen is the plan these numbers describe.
    let unallocated = outstanding;

    for (const bucket of candidates) {
      const branch = branchById.get(bucket.branchId);
      const batch = batchById.get(bucket.batchId);
      if (!branch || !batch) {
        continue;
      }

      const usable = bucket.available;
      if (usable.lessThanOrEqualTo(0)) {
        continue;
      }
      // What the holding branch could spare, which is the only quantity the
      // proposal is ever allowed to draw on. A bucket entirely reserved for its
      // own branch is still listed - the stock is genuinely there, and saying so
      // is more honest than silently dropping it - but nothing is proposed from
      // it and it counts towards no surplus.
      const spare = surplusOf.get(surplusKey(bucket)) ?? ZERO;
      onHandTotal = onHandTotal.plus(usable);
      internalSurplus = internalSurplus.plus(spare);

      const suggested =
        unallocated.greaterThan(0) && spare.greaterThan(0)
          ? spare.lessThan(unallocated)
            ? spare
            : unallocated
          : ZERO;
      unallocated = unallocated.minus(suggested);

      if (canSeeSource(auth, bucket.branchId)) {
        sources.push({
          branch,
          batch,
          available: usable,
          surplus: spare,
          suggested,
          unitCost: bucket.unitCost,
        });
      } else if (spare.greaterThan(0)) {
        // Only spare stock is reported as withheld. Telling a branch pharmacist
        // that "0 units sit at 1 branch you cannot see" would be noise rather
        // than information.
        withheldQuantity = withheldQuantity.plus(spare);
        withheldBranches.add(bucket.branchId);
      }
    }

    // Internal availability is only ever credited up to what is still outstanding:
    // a branch holding 500 spare vials does not make a 100-vial requirement 500
    // fulfillable. It is the surplus that is credited, never the shelf.
    const usableInternal = internalSurplus.greaterThan(outstanding)
      ? outstanding
      : internalSurplus;
    const procurementShortfall = outstanding.minus(usableInternal);

    lines.push({
      productId: item.productId,
      product: item.product ?? { id: item.productId, code: '', name: '', unit: '' },
      requested,
      fulfilled,
      onOrder,
      onTransfer,
      outstanding,
      internalAvailable: usableInternal,
      procurementShortfall: procurementShortfall.greaterThan(0) ? procurementShortfall : ZERO,
      internalSurplus,
      reservedBySourceBranches: onHandTotal.minus(internalSurplus),
      surplusStatus: classifySurplus(internalSurplus, outstanding),
      sources,
      withheldQuantity,
      withheldBranchCount: withheldBranches.size,
    });
  }

  const totals = lines.reduce(
    (acc, line) => ({
      requested: acc.requested.plus(line.requested),
      fulfilled: acc.fulfilled.plus(line.fulfilled),
      outstanding: acc.outstanding.plus(line.outstanding),
      internalAvailable: acc.internalAvailable.plus(line.internalAvailable),
      procurementShortfall: acc.procurementShortfall.plus(line.procurementShortfall),
      internalSurplus: acc.internalSurplus.plus(line.internalSurplus),
      reservedBySourceBranches: acc.reservedBySourceBranches.plus(line.reservedBySourceBranches),
    }),
    {
      requested: ZERO,
      fulfilled: ZERO,
      outstanding: ZERO,
      internalAvailable: ZERO,
      procurementShortfall: ZERO,
      internalSurplus: ZERO,
      reservedBySourceBranches: ZERO,
    }
  );

  return {
    requirement: {
      id: requirement.id,
      documentNumber: requirement.documentNumber,
      status: requirement.status,
      branch: requirement.branch,
    },
    lines,
    totals,
    // Decided from the capped per-line figures, not from the raw surplus: a
    // requirement is only HIGH_SURPLUS when internal stock covers every line it
    // still owes, never because one line happens to have a large shelf behind it.
    surplusStatus: classifySurplus(totals.internalAvailable, totals.outstanding),
    detailRestricted: lines.some((line) => line.withheldBranchCount > 0),
    canCreateTransfer: auth.permissions.includes(Permission.STOCK_TRANSFER_CREATE),
  };
}

/**
 * Wire shape: Decimals become fixed-2 strings, as every other document does.
 *
 * `suggestedInternalQty` and `suggestedProcurementQty` are the same two numbers
 * as `internalAvailable` and `procurementShortfall`, named for the decision they
 * support rather than for the arithmetic behind them. They are deliberately not
 * a second calculation - a caller reading either pair gets the same answer,
 * because there is only one.
 */
export function serializeAvailability(result: RequirementAvailability) {
  return {
    requirement: result.requirement,
    detailRestricted: result.detailRestricted,
    canCreateTransfer: result.canCreateTransfer,
    surplusStatus: result.surplusStatus,
    totals: {
      requested: result.totals.requested.toFixed(2),
      fulfilled: result.totals.fulfilled.toFixed(2),
      outstanding: result.totals.outstanding.toFixed(2),
      internalAvailable: result.totals.internalAvailable.toFixed(2),
      procurementShortfall: result.totals.procurementShortfall.toFixed(2),
      internalSurplus: result.totals.internalSurplus.toFixed(2),
      reservedBySourceBranches: result.totals.reservedBySourceBranches.toFixed(2),
      suggestedInternalQty: result.totals.internalAvailable.toFixed(2),
      suggestedProcurementQty: result.totals.procurementShortfall.toFixed(2),
    },
    lines: result.lines.map((line) => ({
      product: line.product,
      requested: line.requested.toFixed(2),
      fulfilled: line.fulfilled.toFixed(2),
      onOrder: line.onOrder.toFixed(2),
      onTransfer: line.onTransfer.toFixed(2),
      outstanding: line.outstanding.toFixed(2),
      internalAvailable: line.internalAvailable.toFixed(2),
      procurementShortfall: line.procurementShortfall.toFixed(2),
      internalSurplus: line.internalSurplus.toFixed(2),
      reservedBySourceBranches: line.reservedBySourceBranches.toFixed(2),
      surplusStatus: line.surplusStatus,
      suggestedInternalQty: line.internalAvailable.toFixed(2),
      suggestedProcurementQty: line.procurementShortfall.toFixed(2),
      withheldQuantity: line.withheldQuantity.toFixed(2),
      withheldBranchCount: line.withheldBranchCount,
      sources: line.sources.map((source) => ({
        branch: source.branch,
        batch: {
          id: source.batch.id,
          batchNumber: source.batch.batchNumber,
          expiryDate: source.batch.expiryDate,
        },
        available: source.available.toFixed(2),
        surplus: source.surplus.toFixed(2),
        suggested: source.suggested.toFixed(2),
        unitCost: source.unitCost.toFixed(2),
      })),
    })),
  };
}
