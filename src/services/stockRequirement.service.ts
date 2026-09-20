import { DocumentStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest } from '../utils/errors';
import { calculateLineTotals, dec, totalsFromLines, ZERO } from '../utils/decimal';
import { generateDocumentNumber } from '../utils/documentNumber';
import { AuditAction, logDocumentAction } from './audit.service';
import { assertBranchAccess, assertProductInCompany } from './authorization.service';
import {
  DocumentListFilters,
  assertStatus,
  getDocumentDetail,
  listDocuments,
  loadDocumentForUpdate,
  transitionDocumentStatus,
} from './document.service';
import { deliverNotifications, notifyingTransaction } from './notification.service';
import {
  notifyRequirementDecision,
  notifyRequirementFulfilment,
  notifyRequirementSubmitted,
} from './notificationEvents.service';

export interface RequirementLineInput {
  productId: string;
  quantity: string;
  notes?: string;
}

export interface CreateRequirementInput {
  branchId: string;
  /** Business date of the requisition. Defaults to now. */
  documentDate?: Date;
  requiredDate: Date;
  reason: string;
  lines: RequirementLineInput[];
}

/**
 * Requirements are raised against a branch the user may operate in. The branch
 * always comes from the request body but is verified against the caller scope
 * before anything is written.
 */
export async function createRequirement(auth: AuthContext, input: CreateRequirementInput) {
  await assertBranchAccess(auth, input.branchId);

  const products = await Promise.all(
    input.lines.map((line) => assertProductInCompany(auth, line.productId))
  );

  return transaction(async (tx) => {
    const documentNumber = await generateDocumentNumber(
      tx,
      auth.companyId,
      DocumentType.STOCK_REQUIREMENT
    );

    const lineTotals = input.lines.map((line, index) =>
      calculateLineTotals(line.quantity, products[index].purchasePrice, products[index].taxRate)
    );
    const totals = totalsFromLines(lineTotals);

    const document = await tx.document.create({
      data: {
        companyId: auth.companyId,
        branchId: input.branchId,
        documentNumber,
        documentType: DocumentType.STOCK_REQUIREMENT,
        status: DocumentStatus.DRAFT,
        documentDate: input.documentDate ?? new Date(),
        expectedDeliveryDate: input.requiredDate,
        notes: input.reason,
        subtotal: totals.subtotal,
        taxAmount: totals.taxAmount,
        totalAmount: totals.total,
        balanceAmount: totals.total,
        createdById: auth.userId,
        lineItems: {
          create: input.lines.map((line, index) => ({
            lineNumber: index + 1,
            productId: line.productId,
            description: line.notes,
            quantity: dec(line.quantity),
            unitPrice: products[index].purchasePrice,
            subtotal: lineTotals[index].subtotal,
            taxRate: products[index].taxRate,
            taxAmount: lineTotals[index].taxAmount,
            total: lineTotals[index].total,
            unitOfMeasure: products[index].unit,
          })),
        },
      },
    });

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: document.id,
      userId: auth.userId,
      action: AuditAction.CREATE,
      reason: input.reason,
      newData: { status: document.status, documentNumber },
    });

    return document.id;
  });
}

type RequirementRecord = Awaited<ReturnType<typeof loadDocumentForUpdate>>;

async function transition(
  auth: AuthContext,
  id: string,
  allowedFrom: DocumentStatus[],
  nextStatus: DocumentStatus,
  action: (typeof AuditAction)[keyof typeof AuditAction],
  operation: string,
  reason?: string,
  requireBranchAccess = false,
  /**
   * Runs inside the same transaction, after the status change and audit entry
   * have been written and every guard above has passed. A rejected transition
   * therefore never reaches it, and a rollback takes the notification with it.
   */
  notify?: (tx: Prisma.TransactionClient, doc: RequirementRecord) => Promise<unknown>
) {
  await notifyingTransaction(async (tx) => {
    const doc = await loadDocumentForUpdate(tx, auth, id, DocumentType.STOCK_REQUIREMENT);
    assertStatus(doc, allowedFrom, operation);

    if (requireBranchAccess && doc.branchId) {
      await assertBranchAccess(auth, doc.branchId, tx);
    }

    await transitionDocumentStatus(tx, doc, allowedFrom, nextStatus, operation);
    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: id,
      userId: auth.userId,
      action,
      reason: reason ?? null,
      oldData: { status: doc.status },
      newData: { status: nextStatus },
    });

    if (notify) {
      await notify(tx, doc);
    }
  }, deliverNotifications);

  return getDocumentDetail(auth, id);
}

/** Branch display name for a notification message, read inside the transaction. */
async function branchNameFor(
  tx: Prisma.TransactionClient,
  branchId: string | null
): Promise<string> {
  if (!branchId) {
    return 'an unassigned branch';
  }
  const branch = await tx.branch.findUnique({ where: { id: branchId }, select: { name: true } });
  return branch?.name ?? 'an unassigned branch';
}

export function submitRequirement(auth: AuthContext, id: string, reason?: string) {
  return transition(
    auth,
    id,
    [DocumentStatus.DRAFT],
    DocumentStatus.SUBMITTED,
    AuditAction.SUBMIT,
    'submit',
    reason,
    true,
    (tx, doc) =>
      branchNameFor(tx, doc.branchId).then((branchName) =>
        notifyRequirementSubmitted(tx, auth, doc, branchName)
      )
  );
}

export function approveRequirement(auth: AuthContext, id: string, reason?: string) {
  return transition(
    auth,
    id,
    [DocumentStatus.SUBMITTED],
    DocumentStatus.APPROVED,
    AuditAction.APPROVE,
    'approve',
    reason,
    false,
    (tx, doc) => notifyRequirementDecision(tx, auth, doc, DocumentStatus.APPROVED)
  );
}

export function rejectRequirement(auth: AuthContext, id: string, reason: string) {
  if (!reason?.trim()) {
    throw badRequest('A rejection reason is required');
  }
  return transition(
    auth,
    id,
    [DocumentStatus.SUBMITTED],
    DocumentStatus.REJECTED,
    AuditAction.REJECT,
    'reject',
    reason,
    false,
    (tx, doc) => notifyRequirementDecision(tx, auth, doc, DocumentStatus.REJECTED, reason)
  );
}

/**
 * Fulfilment reflects goods actually received against the requirement, not the
 * mere existence of a purchase order.
 */
export async function updateFulfilment(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  requirementId: string,
  receivedByProduct: Map<string, Prisma.Decimal>
) {
  const requirement = await tx.document.findUnique({
    where: { id: requirementId },
    include: { lineItems: true },
  });
  if (!requirement || requirement.companyId !== auth.companyId) {
    return;
  }
  const fulfillable: DocumentStatus[] = [
    DocumentStatus.APPROVED,
    DocumentStatus.PARTIALLY_FULFILLED,
    DocumentStatus.FULFILLED,
  ];
  if (!fulfillable.includes(requirement.status)) {
    return;
  }

  const fullyFulfilled = requirement.lineItems.every((line) => {
    const received = receivedByProduct.get(line.productId);
    return received !== undefined && received.greaterThanOrEqualTo(line.quantity);
  });
  const anyFulfilled = requirement.lineItems.some((line) => {
    const received = receivedByProduct.get(line.productId);
    return received !== undefined && received.greaterThan(0);
  });

  const nextStatus = fullyFulfilled
    ? DocumentStatus.FULFILLED
    : anyFulfilled
      ? DocumentStatus.PARTIALLY_FULFILLED
      : requirement.status;

  if (nextStatus === requirement.status) {
    return;
  }

  // Counted before this transition is written, so it numbers the change about to
  // happen. A requirement knocked back to PARTIALLY_FULFILLED by a correction and
  // then fulfilled again therefore notifies again, while a replay of one
  // transition still de-duplicates.
  const priorTransitions = await tx.documentLog.count({
    where: { documentId: requirementId, action: AuditAction.FULFILMENT_UPDATED },
  });

  await transitionDocumentStatus(
    tx,
    requirement,
    [requirement.status],
    nextStatus,
    'update fulfilment on'
  );
  await logDocumentAction(tx, {
    companyId: auth.companyId,
    documentId: requirementId,
    userId: auth.userId,
    action: AuditAction.FULFILMENT_UPDATED,
    oldData: { status: requirement.status },
    newData: { status: nextStatus },
  });

  await notifyRequirementFulfilment(
    tx,
    auth,
    requirement,
    nextStatus,
    fulfilmentTotals(requirement.lineItems, receivedByProduct),
    priorTransitions
  );
}

/**
 * Progress figures for the notification message, aggregated from exactly the two
 * inputs the status decision above was made from: the requirement's own lines and
 * the accepted-usable map the caller derived from the stock ledger.
 *
 * Over-delivery on one product is capped at what that product was asked for, so
 * a surplus of one item can never disguise a shortfall in another - which is the
 * same reasoning that makes FULFILLED require every line to be satisfied.
 */
function fulfilmentTotals(
  lineItems: { productId: string; quantity: Prisma.Decimal }[],
  receivedByProduct: Map<string, Prisma.Decimal>
) {
  const requestedByProduct = new Map<string, Prisma.Decimal>();
  for (const line of lineItems) {
    requestedByProduct.set(
      line.productId,
      (requestedByProduct.get(line.productId) ?? ZERO).plus(line.quantity)
    );
  }

  let requested = ZERO;
  let received = ZERO;
  for (const [productId, wanted] of requestedByProduct) {
    const got = receivedByProduct.get(productId) ?? ZERO;
    requested = requested.plus(wanted);
    received = received.plus(got.greaterThan(wanted) ? wanted : got);
  }

  return { requested, received, remaining: requested.minus(received) };
}

/**
 * Requisitions carry a line summary, which the other registers do not: choosing
 * the right one - in a picker, or in a list of dozens - is a question about the
 * product and the quantity, and the header alone cannot answer it.
 */
export function listRequirements(auth: AuthContext, filters: DocumentListFilters) {
  return listDocuments(auth, DocumentType.STOCK_REQUIREMENT, filters, {
    includeLineSummary: true,
  });
}
