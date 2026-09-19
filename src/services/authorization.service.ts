import { DocumentType, Prisma } from '@prisma/client';
import { prisma, Database } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { forbidden, notFound } from '../utils/errors';
import { CENTRAL_PROCUREMENT_READ_TYPES } from '../constants/documents';
import { findBranchInCompany } from '../cache/branchCache';

export interface BranchOwned {
  companyId: string;
  branchId?: string | null;
  sourceBranchId?: string | null;
  destinationBranchId?: string | null;
  documentType?: DocumentType;
}

export function isBranchInScope(auth: AuthContext, branchId: string): boolean {
  return auth.hasAllBranches || auth.allowedBranchIds.includes(branchId);
}

/**
 * Resolves a client-supplied branchId to a branch the caller may actually use.
 * Cross-company ids are reported as 404 so the caller cannot probe for their
 * existence; in-company but out-of-scope ids are an explicit 403.
 */
export async function assertBranchAccess(
  auth: AuthContext,
  branchId: string,
  db: Database = prisma
) {
  const branch = await findBranchInCompany(db, auth.companyId, branchId);
  if (!branch) {
    throw notFound('Branch not found');
  }
  if (!isBranchInScope(auth, branchId)) {
    throw forbidden('Access denied for this branch');
  }
  return branch;
}

/** Company-scoped branch lookup without the branch-scope check. */
export async function assertBranchInCompany(
  auth: AuthContext,
  branchId: string,
  db: Database = prisma
) {
  const branch = await findBranchInCompany(db, auth.companyId, branchId);
  if (!branch) {
    throw notFound('Branch not found');
  }
  return branch;
}

/** Every branch id the caller may read, expanded for ALL_BRANCHES users. */
export async function resolveScopedBranchIds(
  auth: AuthContext,
  db: Database = prisma
): Promise<string[]> {
  if (!auth.hasAllBranches) {
    return auth.allowedBranchIds;
  }
  const branches = await db.branch.findMany({
    where: { companyId: auth.companyId },
    select: { id: true },
  });
  return branches.map((branch) => branch.id);
}

export function inventoryScopeWhere(
  auth: AuthContext,
  requestedBranchId?: string
): Prisma.InventoryTransactionWhereInput {
  const where: Prisma.InventoryTransactionWhereInput = { companyId: auth.companyId };
  if (requestedBranchId) {
    where.branchId = requestedBranchId;
  } else if (!auth.hasAllBranches) {
    where.branchId = { in: auth.allowedBranchIds };
  }
  return where;
}

/**
 * Applies company and branch scope to any Document query. Scope is applied to the
 * query itself, never to the result set after fetching.
 */
export function documentScopeWhere(
  auth: AuthContext,
  documentType?: DocumentType
): Prisma.DocumentWhereInput {
  const where: Prisma.DocumentWhereInput = { companyId: auth.companyId };
  if (documentType) {
    where.documentType = documentType;
  }

  if (auth.hasAllBranches) {
    return where;
  }
  if (
    auth.hasCentralWarehouseAccess &&
    documentType &&
    CENTRAL_PROCUREMENT_READ_TYPES.includes(documentType)
  ) {
    return where;
  }

  const ids = auth.allowedBranchIds;
  where.OR = [
    { branchId: { in: ids } },
    { sourceBranchId: { in: ids } },
    { destinationBranchId: { in: ids } },
  ];

  // Mixed-type listings (the document register) keep the same procurement read rule
  // the per-type lists already apply, so the register never shows less than they do.
  if (!documentType && auth.hasCentralWarehouseAccess) {
    where.OR.push({ documentType: { in: CENTRAL_PROCUREMENT_READ_TYPES } });
  }
  return where;
}

export function canReadDocument(auth: AuthContext, doc: BranchOwned): boolean {
  if (doc.companyId !== auth.companyId) {
    return false;
  }
  if (auth.hasAllBranches) {
    return true;
  }
  if (
    auth.hasCentralWarehouseAccess &&
    doc.documentType &&
    CENTRAL_PROCUREMENT_READ_TYPES.includes(doc.documentType)
  ) {
    return true;
  }

  const branchIds = [doc.branchId, doc.sourceBranchId, doc.destinationBranchId].filter(
    (id): id is string => Boolean(id)
  );
  if (branchIds.length === 0) {
    return true;
  }
  return branchIds.some((id) => auth.allowedBranchIds.includes(id));
}

export function assertDocumentReadAccess(auth: AuthContext, doc: BranchOwned) {
  if (doc.companyId !== auth.companyId) {
    throw notFound('Document not found');
  }
  if (!canReadDocument(auth, doc)) {
    throw forbidden('Access denied for this document');
  }
}

export async function assertProductInCompany(
  auth: AuthContext,
  productId: string,
  db: Database = prisma
) {
  const product = await db.product.findFirst({
    where: { id: productId, companyId: auth.companyId },
  });
  if (!product) {
    throw notFound('Product not found');
  }
  return product;
}

export async function assertSupplierInCompany(
  auth: AuthContext,
  supplierId: string,
  db: Database = prisma
) {
  const supplier = await db.supplier.findFirst({
    where: { id: supplierId, companyId: auth.companyId },
  });
  if (!supplier) {
    throw notFound('Supplier not found');
  }
  return supplier;
}

export async function assertBatchForProduct(
  auth: AuthContext,
  batchId: string,
  productId: string,
  db: Database = prisma
) {
  const batch = await db.batch.findFirst({
    where: { id: batchId, companyId: auth.companyId },
  });
  if (!batch) {
    throw notFound('Batch not found');
  }
  if (batch.productId !== productId) {
    throw forbidden('Batch does not belong to the specified product');
  }
  return batch;
}
