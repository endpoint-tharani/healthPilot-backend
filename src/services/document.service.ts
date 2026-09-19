import { DocumentLinkType, DocumentStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { conflict, forbidden, notFound } from '../utils/errors';
import { pageMeta, paginate } from '../schemas/common';
import { IMMUTABLE_DOCUMENT_STATUSES, SORTABLE_DOCUMENT_FIELDS } from '../constants/documents';
import {
  assertBranchInCompany,
  assertDocumentReadAccess,
  documentScopeWhere,
  isBranchInScope,
} from './authorization.service';

export function isPosted(status: DocumentStatus): boolean {
  return IMMUTABLE_DOCUMENT_STATUSES.includes(status);
}

/**
 * Posted ERP documents are never edited in place. Callers must raise a
 * correction, credit note or reversal instead.
 */
export function assertMutable(doc: { documentNumber: string; status: DocumentStatus }) {
  if (isPosted(doc.status)) {
    throw conflict(
      'Document ' + doc.documentNumber + ' is ' + doc.status + ' and can no longer be modified'
    );
  }
}

export function assertStatus(
  doc: { documentNumber: string; status: DocumentStatus },
  allowed: DocumentStatus[],
  operation: string
) {
  if (!allowed.includes(doc.status)) {
    throw conflict(
      'Cannot ' + operation + ' document ' + doc.documentNumber + ' while it is ' + doc.status
    );
  }
}

const DOCUMENT_WITH_LINES = {
  lineItems: {
    orderBy: { lineNumber: 'asc' },
    include: {
      product: { select: { id: true, code: true, name: true, unit: true } },
      batch: { select: { id: true, batchNumber: true, expiryDate: true } },
    },
  },
} satisfies Prisma.DocumentInclude;

/**
 * Loads a document by id within the caller company and branch scope. Cross-company
 * ids answer 404 so an id cannot be used to probe another tenant.
 */
export async function loadAccessibleDocument(
  auth: AuthContext,
  id: string,
  expectedType?: DocumentType
) {
  const doc = await prisma.document.findUnique({
    where: { id },
    include: DOCUMENT_WITH_LINES,
  });
  if (!doc) {
    throw notFound('Document not found');
  }
  assertDocumentReadAccess(auth, doc);
  if (expectedType && doc.documentType !== expectedType) {
    throw notFound('Document not found');
  }
  return doc;
}

/** Same as above but inside a transaction, for write paths. */
export async function loadDocumentForUpdate(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  id: string,
  expectedType: DocumentType
) {
  const doc = await tx.document.findUnique({
    where: { id },
    include: DOCUMENT_WITH_LINES,
  });
  if (!doc || doc.companyId !== auth.companyId || doc.documentType !== expectedType) {
    throw notFound('Document not found');
  }
  assertDocumentReadAccess(auth, doc);
  return doc;
}

export async function linkDocuments(
  tx: Prisma.TransactionClient,
  companyId: string,
  sourceDocumentId: string,
  targetDocumentId: string,
  linkType: DocumentLinkType
) {
  return tx.documentLink.create({
    data: { companyId, sourceDocumentId, targetDocumentId, linkType },
  });
}

export interface DocumentListFilters {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
  status?: string;
  branchId?: string;
  supplierId?: string;
  fromDate?: Date;
  toDate?: Date;
}

/**
 * Authorization scope is baked into the where clause before filters, sorting and
 * pagination are applied - never after fetching.
 */
export async function listDocuments(
  auth: AuthContext,
  documentType: DocumentType | undefined,
  filters: DocumentListFilters
) {
  const where = documentScopeWhere(auth, documentType);

  if (filters.branchId) {
    await assertBranchInCompany(auth, filters.branchId);
    if (!isBranchInScope(auth, filters.branchId)) {
      throw forbidden('Access denied for this branch');
    }
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { branchId: filters.branchId },
          { sourceBranchId: filters.branchId },
          { destinationBranchId: filters.branchId },
        ],
      },
    ];
  }

  if (filters.status) {
    const statuses = filters.status
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is DocumentStatus => s in DocumentStatus);
    if (statuses.length > 0) {
      where.status = { in: statuses };
    }
  }
  if (filters.supplierId) {
    where.supplierId = filters.supplierId;
  }
  if (filters.search) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { documentNumber: { contains: filters.search, mode: 'insensitive' } },
          { supplierRef: { contains: filters.search, mode: 'insensitive' } },
          { notes: { contains: filters.search, mode: 'insensitive' } },
        ],
      },
    ];
  }
  if (filters.fromDate || filters.toDate) {
    where.documentDate = {
      ...(filters.fromDate ? { gte: filters.fromDate } : {}),
      ...(filters.toDate ? { lte: filters.toDate } : {}),
    };
  }

  const sortField =
    filters.sortBy && SORTABLE_DOCUMENT_FIELDS.has(filters.sortBy) ? filters.sortBy : 'createdAt';

  const [total, rows] = await Promise.all([
    prisma.document.count({ where }),
    prisma.document.findMany({
      where,
      ...paginate(filters),
      orderBy: { [sortField]: filters.sortOrder },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        sourceBranch: { select: { id: true, code: true, name: true } },
        destinationBranch: { select: { id: true, code: true, name: true } },
        supplier: { select: { id: true, code: true, name: true } },
        createdBy: { select: { id: true, name: true, email: true } },
        _count: { select: { lineItems: true } },
      },
    }),
  ]);

  return { data: rows.map(serializeDocumentHeader), meta: pageMeta(filters, total) };
}

type DocumentHeader = {
  id: string;
  documentNumber: string;
  documentType: DocumentType;
  status: DocumentStatus;
  documentDate: Date;
  expectedDeliveryDate: Date | null;
  subtotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  balanceAmount: Prisma.Decimal;
  disputedAmount: Prisma.Decimal;
  notes: string | null;
  supplierRef: string | null;
  patientRef: string | null;
  prescriptionRef: string | null;
  createdAt: Date;
};

export function serializeDocumentHeader<T extends DocumentHeader>(doc: T) {
  return {
    ...doc,
    subtotal: doc.subtotal.toFixed(2),
    taxAmount: doc.taxAmount.toFixed(2),
    totalAmount: doc.totalAmount.toFixed(2),
    paidAmount: doc.paidAmount.toFixed(2),
    balanceAmount: doc.balanceAmount.toFixed(2),
    disputedAmount: doc.disputedAmount.toFixed(2),
  };
}

/** Cross-type register listing. Type is one more filter; scope stays untouched. */
export function listDocumentRegister(
  auth: AuthContext,
  filters: DocumentListFilters & { documentType?: DocumentType }
) {
  return listDocuments(auth, filters.documentType, filters);
}

/**
 * Full ERP traceability for one document: header, lines, both link directions,
 * stock movements, payment allocations and audit history.
 */
export async function getDocumentDetail(auth: AuthContext, id: string) {
  const doc = await prisma.document.findUnique({
    where: { id },
    include: {
      branch: { select: { id: true, code: true, name: true, type: true } },
      sourceBranch: { select: { id: true, code: true, name: true, type: true } },
      destinationBranch: { select: { id: true, code: true, name: true, type: true } },
      supplier: { select: { id: true, code: true, name: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      lineItems: {
        orderBy: { lineNumber: 'asc' },
        include: {
          product: { select: { id: true, code: true, name: true, unit: true } },
          batch: { select: { id: true, batchNumber: true, expiryDate: true } },
        },
      },
      sourceLinks: {
        include: {
          targetDocument: {
            select: { id: true, documentNumber: true, documentType: true, status: true },
          },
        },
      },
      targetLinks: {
        include: {
          sourceDocument: {
            select: { id: true, documentNumber: true, documentType: true, status: true },
          },
        },
      },
      inventoryTransactions: {
        orderBy: { transactionDate: 'asc' },
        include: {
          branch: { select: { id: true, code: true, name: true } },
          product: { select: { id: true, code: true, name: true } },
          batch: { select: { id: true, batchNumber: true } },
          // Read-only projection: the ledger already records who posted each
          // movement, and the document view shows it alongside the quantity.
          createdBy: { select: { id: true, name: true, email: true } },
        },
      },
      paymentAllocations: {
        include: {
          payment: {
            select: {
              id: true,
              paymentNumber: true,
              method: true,
              amount: true,
              paymentDate: true,
            },
          },
        },
      },
      documentLogs: {
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, name: true, email: true } } },
      },
    },
  });

  if (!doc) {
    throw notFound('Document not found');
  }
  assertDocumentReadAccess(auth, doc);

  const canViewAudit = auth.permissions.includes('AUDIT_VIEW');

  return {
    ...serializeDocumentHeader(doc),
    branch: doc.branch,
    sourceBranch: doc.sourceBranch,
    destinationBranch: doc.destinationBranch,
    supplier: doc.supplier,
    createdBy: doc.createdBy,
    lineItems: doc.lineItems.map(serializeLineItem),
    links: {
      outgoing: doc.sourceLinks.map((l) => ({
        linkType: l.linkType,
        document: l.targetDocument,
      })),
      incoming: doc.targetLinks.map((l) => ({
        linkType: l.linkType,
        document: l.sourceDocument,
      })),
    },
    inventoryTransactions: doc.inventoryTransactions.map((t) => ({
      id: t.id,
      branch: t.branch,
      product: t.product,
      batch: t.batch,
      createdBy: t.createdBy,
      transactionType: t.transactionType,
      stockStatus: t.stockStatus,
      quantity: t.quantity.toFixed(2),
      unitCost: t.unitCost.toFixed(2),
      totalCost: t.totalCost.toFixed(2),
      transactionDate: t.transactionDate,
      notes: t.notes,
    })),
    paymentAllocations: doc.paymentAllocations.map((a) => ({
      id: a.id,
      allocatedAmount: a.allocatedAmount.toFixed(2),
      payment: {
        ...a.payment,
        amount: a.payment.amount.toFixed(2),
      },
    })),
    history: canViewAudit
      ? doc.documentLogs.map((log) => ({
          id: log.id,
          action: log.action,
          reason: log.reason,
          changes: log.changes ? JSON.parse(log.changes) : null,
          user: log.user,
          createdAt: log.createdAt,
        }))
      : undefined,
  };
}

export function serializeLineItem(line: {
  id: string;
  lineNumber: number;
  productId: string;
  batchId: string | null;
  description: string | null;
  quantity: Prisma.Decimal;
  acceptedQuantity: Prisma.Decimal | null;
  damagedQuantity: Prisma.Decimal | null;
  missingQuantity: Prisma.Decimal | null;
  unitPrice: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  unitOfMeasure: string | null;
  referenceLineItemId: string | null;
  product?: { id: string; code: string; name: string; unit: string } | null;
  batch?: { id: string; batchNumber: string; expiryDate: Date } | null;
}) {
  return {
    id: line.id,
    lineNumber: line.lineNumber,
    product: line.product ?? { id: line.productId },
    batch: line.batch ?? null,
    description: line.description,
    quantity: line.quantity.toFixed(2),
    acceptedQuantity: line.acceptedQuantity?.toFixed(2) ?? null,
    damagedQuantity: line.damagedQuantity?.toFixed(2) ?? null,
    missingQuantity: line.missingQuantity?.toFixed(2) ?? null,
    unitPrice: line.unitPrice.toFixed(2),
    subtotal: line.subtotal.toFixed(2),
    taxRate: line.taxRate.toFixed(2),
    taxAmount: line.taxAmount.toFixed(2),
    total: line.total.toFixed(2),
    unitOfMeasure: line.unitOfMeasure,
    referenceLineItemId: line.referenceLineItemId,
  };
}

export async function getDocumentHistory(auth: AuthContext, id: string) {
  const doc = await prisma.document.findUnique({
    where: { id },
    select: {
      id: true,
      companyId: true,
      documentNumber: true,
      documentType: true,
      branchId: true,
      sourceBranchId: true,
      destinationBranchId: true,
    },
  });
  if (!doc) {
    throw notFound('Document not found');
  }
  assertDocumentReadAccess(auth, doc);

  const logs = await prisma.documentLog.findMany({
    where: { documentId: id, companyId: auth.companyId },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
  });

  return {
    document: {
      id: doc.id,
      documentNumber: doc.documentNumber,
      documentType: doc.documentType,
    },
    history: logs.map((log) => ({
      id: log.id,
      action: log.action,
      reason: log.reason,
      changes: log.changes ? JSON.parse(log.changes) : null,
      user: log.user,
      createdAt: log.createdAt,
    })),
  };
}
