import {
  AccountingStatus,
  DocumentLinkType,
  DocumentStatus,
  DocumentType,
  Prisma,
} from '@prisma/client';
import { prisma } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { conflict, forbidden, notFound } from '../utils/errors';
import { pageMeta, paginate } from '../schemas/common';
import {
  CENTRAL_PROCUREMENT_READ_TYPES,
  IMMUTABLE_DOCUMENT_STATUSES,
  SORTABLE_DOCUMENT_FIELDS,
} from '../constants/documents';
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

/**
 * Moves a document from one of a set of statuses to the next one, atomically.
 *
 * `assertStatus` above reads and checks, which is honest but not safe on its
 * own: between that read and the write, another request holding the same
 * document can post it, dispatch it or cancel it, and both transactions then
 * write their stock movements. Posting a goods receipt twice that way puts the
 * goods on the shelf twice, and no later reconciliation can tell which of the
 * two ledgers was the real delivery.
 *
 * The status test therefore lives in the WHERE clause of the update itself:
 *
 *   UPDATE document SET status = :next WHERE id = :id AND status IN (:allowed)
 *
 * PostgreSQL takes the row lock on that statement, so a second transaction
 * attempting the same transition blocks until the first commits and then
 * re-evaluates the predicate against the committed row - matching nothing, and
 * reporting zero affected rows. Zero is the concurrency signal, and it is an
 * error rather than a silent no-op.
 *
 * Callers run this BEFORE writing stock movements, so the loser of a race is
 * refused before it touches the ledger rather than after.
 */
export async function transitionDocumentStatus(
  tx: Prisma.TransactionClient,
  doc: { id: string; documentNumber: string },
  allowedFrom: DocumentStatus[],
  nextStatus: DocumentStatus,
  operation: string
): Promise<void> {
  const result = await tx.document.updateMany({
    where: { id: doc.id, status: { in: allowedFrom } },
    data: { status: nextStatus },
  });

  if (result.count === 0) {
    const current = await tx.document.findUnique({
      where: { id: doc.id },
      select: { status: true },
    });
    throw conflict(
      'Cannot ' +
        operation +
        ' document ' +
        doc.documentNumber +
        ' while it is ' +
        (current?.status ?? 'no longer available') +
        '. Another user changed it first; reload and try again.'
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

export interface DocumentListOptions {
  /**
   * Adds the first few product lines to each row.
   *
   * Off by default, because most listings are registers where the header is the
   * whole point and the extra read would be waste. It is on for stock
   * requisitions, where a picker has to tell REQ-0001 from REQ-0002 by what was
   * asked for and how much, which the header alone cannot say.
   */
  includeLineSummary?: boolean;
}

/** Lines shown per row in a line summary; enough to identify, never a full document. */
const LINE_SUMMARY_LIMIT = 3;

/**
 * The first few lines of each document in a page of results, in one read.
 *
 * Prisma cannot limit rows per group, so the page's lines are fetched together
 * and capped per document here. A page is at most `limit` documents, so this is
 * one extra query for the page rather than one per row.
 */
async function loadLineSummaries(documentIds: string[]) {
  const lines = await prisma.documentLineItem.findMany({
    where: { documentId: { in: documentIds } },
    orderBy: [{ documentId: 'asc' }, { lineNumber: 'asc' }],
    select: {
      documentId: true,
      quantity: true,
      unitOfMeasure: true,
      product: { select: { id: true, code: true, name: true, unit: true } },
    },
  });

  const byDocument = new Map<
    string,
    { product: { id: string; code: string; name: string; unit: string }; quantity: string; unitOfMeasure: string | null }[]
  >();
  for (const line of lines) {
    const current = byDocument.get(line.documentId) ?? [];
    if (current.length < LINE_SUMMARY_LIMIT) {
      current.push({
        product: line.product,
        quantity: line.quantity.toFixed(2),
        unitOfMeasure: line.unitOfMeasure,
      });
    }
    byDocument.set(line.documentId, current);
  }
  return byDocument;
}

/**
 * Authorization scope is baked into the where clause before filters, sorting and
 * pagination are applied - never after fetching.
 */
export async function listDocuments(
  auth: AuthContext,
  documentType: DocumentType | undefined,
  filters: DocumentListFilters,
  options: DocumentListOptions = {}
) {
  const where = documentScopeWhere(auth, documentType);

  if (filters.branchId) {
    await assertBranchInCompany(auth, filters.branchId);
    /**
     * Central procurement users may already READ requisitions and orders for the
     * whole company - that is the rule `documentScopeWhere` applies above. Asking
     * to see only one branch's is a narrowing of what they can already see, so
     * refusing it here made the filter stricter than the scope it filters, and
     * left the central pharmacy unable to look up the requisition a transfer is
     * being raised for.
     */
    const readableUnderProcurementRule =
      auth.hasCentralWarehouseAccess &&
      documentType !== undefined &&
      CENTRAL_PROCUREMENT_READ_TYPES.includes(documentType);

    if (!isBranchInScope(auth, filters.branchId) && !readableUnderProcurementRule) {
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
    const contains = { contains: filters.search, mode: 'insensitive' } as const;
    // Branch and product are part of how a person names a document out loud -
    // "Branch A's insulin requisition" - so a search that only read the document
    // number forced them to know the number before they could look it up.
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { documentNumber: contains },
          { supplierRef: contains },
          { notes: contains },
          { branch: { is: { name: contains } } },
          { branch: { is: { code: contains } } },
          { sourceBranch: { is: { name: contains } } },
          { destinationBranch: { is: { name: contains } } },
          { supplier: { is: { name: contains } } },
          { lineItems: { some: { product: { is: { name: contains } } } } },
          { lineItems: { some: { product: { is: { code: contains } } } } },
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

  const lineSummaries =
    options.includeLineSummary && rows.length > 0
      ? await loadLineSummaries(rows.map((row) => row.id))
      : null;

  return {
    data: rows.map((row) => ({
      ...serializeDocumentHeader(row),
      ...(lineSummaries ? { lineSummary: lineSummaries.get(row.id) ?? [] } : {}),
    })),
    meta: pageMeta(filters, total),
  };
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
  accountingStatus: AccountingStatus;
  accountingMessage: string | null;
  accountingPostedAt: Date | null;
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
    /**
     * Where the document stands with the books, as one object rather than three
     * loose fields, so a client reads a status and its reason together. POSTED
     * has a journal behind it; PENDING and FAILED carry the reason and are
     * retryable; SKIPPED and NOT_REQUIRED are answers, not gaps.
     */
    accounting: {
      status: doc.accountingStatus,
      message: doc.accountingMessage,
      postedAt: doc.accountingPostedAt,
    },
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
