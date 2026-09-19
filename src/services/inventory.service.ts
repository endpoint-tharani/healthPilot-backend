import {
  DocumentStatus,
  DocumentType,
  InventoryTransactionType,
  Prisma,
  StockStatus,
} from '@prisma/client';
import { prisma, Database } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { conflict, forbidden } from '../utils/errors';
import { dec, money, ZERO } from '../utils/decimal';
import {
  assertBranchInCompany,
  inventoryScopeWhere,
  isBranchInScope,
} from './authorization.service';
import { pageMeta, paginate } from '../schemas/common';

export interface StockMovementInput {
  companyId: string;
  branchId: string;
  productId: string;
  batchId: string;
  documentId?: string;
  documentLineItemId?: string;
  transactionType: InventoryTransactionType;
  /** Signed: positive increases stock, negative decreases it. */
  quantity: Prisma.Decimal | string | number;
  unitCost: Prisma.Decimal | string | number;
  stockStatus: StockStatus;
  createdById: string;
  notes?: string;
}

/**
 * Serialises reads and writes for a set of stock buckets inside the caller
 * transaction. Two concurrent dispensings of the same batch therefore queue, and
 * the second one sees the first movement before it checks the balance.
 *
 * Every bucket is locked in one round trip, in a stable sorted order: over a
 * network database a lock per line was the dominant cost of posting a document,
 * and the fixed order is what stops two postings that share buckets deadlocking.
 */
export async function lockStockBuckets(tx: Prisma.TransactionClient, keys: string[]) {
  if (keys.length === 0) {
    return;
  }
  const locks = Prisma.join(
    [...keys].sort().map((key) => Prisma.sql`pg_advisory_xact_lock(hashtext(${key}))`)
  );
  await tx.$executeRaw`SELECT ${locks}`;
}

export function bucketKey(bucket: {
  branchId: string;
  productId: string;
  batchId: string;
  stockStatus: StockStatus;
}): string {
  return [bucket.branchId, bucket.productId, bucket.batchId, bucket.stockStatus].join(':');
}

export async function getStockBalance(
  tx: Prisma.TransactionClient,
  params: {
    companyId: string;
    branchId: string;
    productId: string;
    batchId: string;
    stockStatus: StockStatus;
  }
): Promise<Prisma.Decimal> {
  const result = await tx.inventoryTransaction.aggregate({
    where: {
      companyId: params.companyId,
      branchId: params.branchId,
      productId: params.productId,
      batchId: params.batchId,
      stockStatus: params.stockStatus,
    },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? ZERO;
}

/**
 * The single write path into the stock ledger. Outbound movements are checked
 * against the live balance under lock, so normal operations can never drive a
 * bucket negative.
 *
 * Movements are posted as a set: a document's lines lock, check and insert in
 * three round trips rather than three per line. Lines that draw down the same
 * bucket are netted before the check, which is the same answer the per-line
 * checks gave when each one saw the previous insert.
 */
export async function recordStockMovements(
  tx: Prisma.TransactionClient,
  inputs: StockMovementInput[]
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }

  const rows = inputs.map((input) => {
    const quantity = dec(input.quantity);
    if (quantity.isZero()) {
      throw conflict('Stock movement quantity cannot be zero');
    }
    const unitCost = money(input.unitCost);
    return { input, quantity, unitCost };
  });

  const buckets = new Map<
    string,
    {
      companyId: string;
      branchId: string;
      productId: string;
      batchId: string;
      stockStatus: StockStatus;
      drawdown: Prisma.Decimal;
    }
  >();

  for (const { input, quantity } of rows) {
    const key = bucketKey(input);
    const bucket = buckets.get(key) ?? {
      companyId: input.companyId,
      branchId: input.branchId,
      productId: input.productId,
      batchId: input.batchId,
      stockStatus: input.stockStatus,
      drawdown: ZERO,
    };
    if (quantity.isNegative()) {
      bucket.drawdown = bucket.drawdown.plus(quantity);
    }
    buckets.set(key, bucket);
  }

  await lockStockBuckets(tx, [...buckets.keys()]);

  const drawn = [...buckets.values()].filter((bucket) => bucket.drawdown.isNegative());
  if (drawn.length > 0) {
    const balances = await tx.inventoryTransaction.groupBy({
      by: ['branchId', 'productId', 'batchId', 'stockStatus'],
      where: {
        OR: drawn.map((bucket) => ({
          companyId: bucket.companyId,
          branchId: bucket.branchId,
          productId: bucket.productId,
          batchId: bucket.batchId,
          stockStatus: bucket.stockStatus,
        })),
      },
      _sum: { quantity: true },
    });

    const balanceByKey = new Map(
      balances.map((row) => [bucketKey(row), row._sum.quantity ?? ZERO])
    );

    for (const bucket of drawn) {
      const balance = balanceByKey.get(bucketKey(bucket)) ?? ZERO;
      if (balance.plus(bucket.drawdown).lessThan(0)) {
        throw conflict(
          'Insufficient ' +
            bucket.stockStatus.toLowerCase() +
            ' stock: available ' +
            balance.toFixed(2) +
            ', required ' +
            bucket.drawdown.abs().toFixed(2)
        );
      }
    }
  }

  await tx.inventoryTransaction.createMany({
    data: rows.map(({ input, quantity, unitCost }) => ({
      companyId: input.companyId,
      branchId: input.branchId,
      productId: input.productId,
      batchId: input.batchId,
      documentId: input.documentId,
      documentLineItemId: input.documentLineItemId,
      transactionType: input.transactionType,
      quantity,
      unitCost,
      totalCost: money(quantity.times(unitCost)),
      stockStatus: input.stockStatus,
      createdById: input.createdById,
      notes: input.notes,
    })),
  });
}

export interface StockFilters {
  branchId?: string;
  productId?: string;
  batchId?: string;
  stockStatus?: StockStatus;
}

/** One stock bucket: a branch's holding of one batch of one product in one status. */
export interface StockBucket {
  branchId: string;
  productId: string;
  batchId: string;
  quantity: Prisma.Decimal;
  stockValue: Prisma.Decimal;
  /**
   * Weighted average cost of what is actually left in the bucket, taken from the
   * ledger's own `totalCost` rather than the product master. Batch is part of the
   * bucket key, so stock bought at two prices under two batch numbers keeps two
   * costs; only repeat receipts of the *same* batch at different prices average.
   */
  unitCost: Prisma.Decimal;
}

/**
 * The stock position by bucket, for any caller-supplied filter.
 *
 * This is the one groupBy the whole system derives stock on hand from. Both the
 * scoped stock report and the cross-branch availability check call it, so neither
 * can drift from the other or from the ledger.
 *
 * The `where` is the caller's responsibility: it decides the branch scope, and
 * every caller is expected to have already applied company scope to it.
 */
export async function getStockBuckets(
  db: Database,
  where: Prisma.InventoryTransactionWhereInput
): Promise<StockBucket[]> {
  const grouped = await db.inventoryTransaction.groupBy({
    by: ['branchId', 'productId', 'batchId'],
    where,
    _sum: { quantity: true, totalCost: true },
  });

  return grouped
    .map((row) => {
      const quantity = row._sum.quantity ?? ZERO;
      const stockValue = row._sum.totalCost ?? ZERO;
      return {
        branchId: row.branchId,
        productId: row.productId,
        batchId: row.batchId,
        quantity,
        stockValue,
        unitCost: quantity.isZero() ? ZERO : money(stockValue.dividedBy(quantity)),
      };
    })
    .filter((bucket) => bucket.quantity.greaterThan(0));
}

async function assertRequestedBranch(auth: AuthContext, branchId?: string) {
  if (!branchId) {
    return;
  }
  await assertBranchInCompany(auth, branchId);
  if (!isBranchInScope(auth, branchId)) {
    throw forbidden('Access denied for this branch');
  }
}

/**
 * Stock on hand is always derived from InventoryTransaction - there is no second
 * source of truth that could drift from the ledger.
 */
export async function getStockSummary(auth: AuthContext, filters: StockFilters) {
  await assertRequestedBranch(auth, filters.branchId);

  const where = inventoryScopeWhere(auth, filters.branchId);
  if (filters.productId) where.productId = filters.productId;
  if (filters.batchId) where.batchId = filters.batchId;
  if (filters.stockStatus) where.stockStatus = filters.stockStatus;

  const grouped = await prisma.inventoryTransaction.groupBy({
    by: ['branchId', 'productId', 'batchId', 'stockStatus'],
    where,
    _sum: { quantity: true, totalCost: true },
  });

  const [branches, products, batches] = await Promise.all([
    prisma.branch.findMany({
      where: { companyId: auth.companyId },
      select: { id: true, code: true, name: true, type: true },
    }),
    prisma.product.findMany({
      where: { companyId: auth.companyId },
      select: { id: true, code: true, name: true, unit: true },
    }),
    prisma.batch.findMany({
      where: { companyId: auth.companyId },
      select: { id: true, batchNumber: true, expiryDate: true, status: true },
    }),
  ]);

  const branchById = new Map(branches.map((b) => [b.id, b]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const batchById = new Map(batches.map((b) => [b.id, b]));

  return grouped
    .map((row) => ({
      branch: branchById.get(row.branchId) ?? null,
      product: productById.get(row.productId) ?? null,
      batch: batchById.get(row.batchId) ?? null,
      stockStatus: row.stockStatus,
      quantity: (row._sum.quantity ?? ZERO).toFixed(2),
      stockValue: (row._sum.totalCost ?? ZERO).toFixed(2),
    }))
    .filter((row) => !dec(row.quantity).isZero())
    .sort((a, b) => {
      const branchCmp = (a.branch?.code ?? '').localeCompare(b.branch?.code ?? '');
      if (branchCmp !== 0) return branchCmp;
      const productCmp = (a.product?.code ?? '').localeCompare(b.product?.code ?? '');
      if (productCmp !== 0) return productCmp;
      return a.stockStatus.localeCompare(b.stockStatus);
    });
}

/** A bucket with the part of it that is already promised to somebody else. */
export interface SourceableBucket extends StockBucket {
  /** Quantity on raised-but-undispatched transfers out of this bucket. */
  committed: Prisma.Decimal;
  /** What a new transfer could actually take: on hand less committed. */
  available: Prisma.Decimal;
}

/**
 * Stock that could genuinely be sent somewhere, which is not the same as stock on
 * hand.
 *
 * A transfer in DRAFT has not moved anything - the ledger still shows the full
 * quantity at the source - but it has been promised to a requirement, and
 * offering it to a second one would let two branches be told they are getting the
 * same vials. Once a transfer is DISPATCHED the ledger has the TRANSFER_OUT row,
 * so the quantity has already left the on-hand figure and must not be subtracted
 * twice; DRAFT is therefore the only status counted here.
 *
 * This is the single definition of "available to send", used both by the sourcing
 * view and by the check that guards transfer creation, so the number a user is
 * shown is the number the backend will enforce.
 */
export async function getSourceableStock(
  db: Database,
  where: Prisma.InventoryTransactionWhereInput,
  scope: { companyId: string; branchIds?: string[]; productIds?: string[] }
): Promise<SourceableBucket[]> {
  const buckets = await getStockBuckets(db, where);
  if (buckets.length === 0) {
    return [];
  }

  const committedLines = await db.documentLineItem.findMany({
    where: {
      document: {
        companyId: scope.companyId,
        documentType: DocumentType.STOCK_TRANSFER,
        status: DocumentStatus.DRAFT,
        ...(scope.branchIds ? { sourceBranchId: { in: scope.branchIds } } : {}),
      },
      productId: { in: scope.productIds ?? [...new Set(buckets.map((b) => b.productId))] },
      batchId: { in: [...new Set(buckets.map((b) => b.batchId))] },
    },
    select: {
      productId: true,
      batchId: true,
      quantity: true,
      document: { select: { sourceBranchId: true } },
    },
  });

  const committedByBucket = new Map<string, Prisma.Decimal>();
  for (const line of committedLines) {
    const branchId = line.document.sourceBranchId;
    if (!branchId || !line.batchId) {
      continue;
    }
    const key = [branchId, line.productId, line.batchId].join(':');
    committedByBucket.set(key, (committedByBucket.get(key) ?? ZERO).plus(line.quantity));
  }

  return buckets.map((bucket) => {
    const committed =
      committedByBucket.get([bucket.branchId, bucket.productId, bucket.batchId].join(':')) ?? ZERO;
    const available = bucket.quantity.minus(committed);
    return {
      ...bucket,
      committed,
      available: available.greaterThan(0) ? available : ZERO,
    };
  });
}

export interface LedgerFilters extends StockFilters {
  transactionType?: InventoryTransactionType;
  fromDate?: Date;
  toDate?: Date;
  page: number;
  limit: number;
  sortOrder: 'asc' | 'desc';
}

export async function getLedger(auth: AuthContext, filters: LedgerFilters) {
  await assertRequestedBranch(auth, filters.branchId);

  const where = inventoryScopeWhere(auth, filters.branchId);
  if (filters.productId) where.productId = filters.productId;
  if (filters.batchId) where.batchId = filters.batchId;
  if (filters.stockStatus) where.stockStatus = filters.stockStatus;
  if (filters.transactionType) where.transactionType = filters.transactionType;
  if (filters.fromDate || filters.toDate) {
    where.transactionDate = {
      ...(filters.fromDate ? { gte: filters.fromDate } : {}),
      ...(filters.toDate ? { lte: filters.toDate } : {}),
    };
  }

  const [total, rows] = await Promise.all([
    prisma.inventoryTransaction.count({ where }),
    prisma.inventoryTransaction.findMany({
      where,
      ...paginate(filters),
      orderBy: { transactionDate: filters.sortOrder },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        product: { select: { id: true, code: true, name: true } },
        batch: { select: { id: true, batchNumber: true, expiryDate: true } },
        document: { select: { id: true, documentNumber: true, documentType: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id,
      branch: r.branch,
      product: r.product,
      batch: r.batch,
      document: r.document,
      createdBy: r.createdBy,
      transactionType: r.transactionType,
      stockStatus: r.stockStatus,
      quantity: r.quantity.toFixed(2),
      unitCost: r.unitCost.toFixed(2),
      totalCost: r.totalCost.toFixed(2),
      transactionDate: r.transactionDate,
      notes: r.notes,
    })),
    meta: pageMeta(filters, total),
  };
}
