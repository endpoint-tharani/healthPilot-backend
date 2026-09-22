import {
  AccountingStatus,
  DocumentStatus,
  DocumentType,
  PaymentMethod,
  Prisma,
} from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { money, ZERO } from '../utils/decimal';
import { generatePaymentNumber } from '../utils/documentNumber';
import { AuditAction, logDocumentAction } from './audit.service';
import { assertBranchAccess, assertSupplierInCompany } from './authorization.service';
import { computeInvoiceFinancials } from './invoiceFinancials';
import { autoPostPaymentAccounting } from './accounting/autoPost.service';
import { deliverNotifications, notifyingTransaction } from './notification.service';
import { notifyPaymentAllocated } from './notificationEvents.service';
import { Pagination, pageMeta, paginate } from '../schemas/common';

export interface CreatePaymentInput {
  supplierId: string;
  branchId: string;
  amount: string;
  method: PaymentMethod;
  paymentDate?: Date;
  reference?: string;
  notes?: string;
  allocations?: AllocationInput[];
}

export interface AllocationInput {
  documentId: string;
  amount: string;
}

export interface PaymentListQuery extends Pagination {
  supplierId?: string;
  branchId?: string;
  method?: PaymentMethod;
  fromDate?: Date;
  toDate?: Date;
}

function serializePayment(payment: {
  id: string;
  paymentNumber: string;
  amount: Prisma.Decimal;
  method: PaymentMethod;
  paymentDate: Date;
  reference: string | null;
  notes: string | null;
  accountingStatus: AccountingStatus;
  accountingMessage: string | null;
  accountingPostedAt: Date | null;
  allocations?: { id: string; allocatedAmount: Prisma.Decimal; document?: unknown }[];
}) {
  const allocated = (payment.allocations ?? []).reduce<Prisma.Decimal>(
    (acc, a) => acc.plus(a.allocatedAmount),
    ZERO
  );
  return {
    ...payment,
    amount: payment.amount.toFixed(2),
    allocatedAmount: allocated.toFixed(2),
    unallocatedAmount: payment.amount.minus(allocated).toFixed(2),
    allocations: (payment.allocations ?? []).map((a) => ({
      ...a,
      allocatedAmount: a.allocatedAmount.toFixed(2),
    })),
    // Mirrors the document shape, so the payment page can show the same accounting
    // status and the same retry affordance without a second contract.
    accounting: {
      status: payment.accountingStatus,
      message: payment.accountingMessage,
      postedAt: payment.accountingPostedAt,
    },
  };
}

export async function createPayment(auth: AuthContext, input: CreatePaymentInput) {
  const amount = money(input.amount);
  if (amount.lessThanOrEqualTo(0)) {
    throw badRequest('Payment amount must be greater than 0');
  }

  await assertSupplierInCompany(auth, input.supplierId);
  await assertBranchAccess(auth, input.branchId);

  const paymentId = await notifyingTransaction(async (tx) => {
    const paymentNumber = await generatePaymentNumber(tx, auth.companyId);
    const payment = await tx.payment.create({
      data: {
        companyId: auth.companyId,
        branchId: input.branchId,
        supplierId: input.supplierId,
        paymentNumber,
        amount,
        method: input.method,
        paymentDate: input.paymentDate ?? new Date(),
        reference: input.reference,
        notes: input.notes,
        createdById: auth.userId,
      },
    });

    if (input.allocations?.length) {
      await applyAllocations(tx, auth, payment.id, input.allocations);
    }

    // Booked for what the payment settles, not for what it is worth. A payment
    // created without allocations settles nothing yet and is left PENDING until
    // an allocation gives it a liability to clear.
    await autoPostPaymentAccounting(tx, auth, payment.id);

    return payment.id;
  }, deliverNotifications);

  return getPayment(auth, paymentId);
}

/**
 * Allocation rules enforced here: a payment can never allocate more than it is
 * worth, an invoice can never receive more than it can still legitimately take,
 * and disputed value is excluded until a credit note clears it.
 */
async function applyAllocations(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  paymentId: string,
  allocations: AllocationInput[]
) {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    include: { allocations: true },
  });
  if (!payment || payment.companyId !== auth.companyId) {
    throw notFound('Payment not found');
  }

  let alreadyAllocated = payment.allocations.reduce<Prisma.Decimal>(
    (acc, a) => acc.plus(a.allocatedAmount),
    ZERO
  );

  for (const allocation of allocations) {
    const amount = money(allocation.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw badRequest('Allocation amount must be greater than 0');
    }

    const invoice = await tx.document.findUnique({ where: { id: allocation.documentId } });
    if (
      !invoice ||
      invoice.companyId !== auth.companyId ||
      invoice.documentType !== DocumentType.SUPPLIER_INVOICE
    ) {
      throw notFound('Supplier invoice not found');
    }
    if (invoice.supplierId !== payment.supplierId) {
      throw conflict('Payment supplier does not match invoice ' + invoice.documentNumber);
    }
    if (invoice.status === DocumentStatus.CANCELLED) {
      throw conflict('Cannot allocate to a cancelled invoice');
    }
    if (invoice.branchId && !auth.hasAllBranches && !auth.allowedBranchIds.includes(invoice.branchId)) {
      throw forbidden('Access denied for this invoice');
    }

    const remainingOnPayment = payment.amount.minus(alreadyAllocated);
    if (amount.greaterThan(remainingOnPayment)) {
      throw conflict(
        'Allocation of ' +
          amount.toFixed(2) +
          ' exceeds the unallocated payment balance of ' +
          remainingOnPayment.toFixed(2)
      );
    }

    const financials = await computeInvoiceFinancials(tx, invoice);
    if (amount.greaterThan(financials.allocatableAmount)) {
      throw conflict(
        'Allocation of ' +
          amount.toFixed(2) +
          ' exceeds the allocatable balance of ' +
          financials.allocatableAmount.toFixed(2) +
          ' on ' +
          invoice.documentNumber
      );
    }

    await tx.paymentAllocation.create({
      data: { paymentId, documentId: invoice.id, allocatedAmount: amount },
    });

    const paidAmount = money(invoice.paidAmount.plus(amount));
    const balanceAmount = money(
      invoice.totalAmount.minus(financials.creditedAmount).minus(paidAmount)
    );
    const settled = financials.allocatableAmount.minus(amount).lessThanOrEqualTo(0);

    await tx.document.update({
      where: { id: invoice.id },
      data: {
        paidAmount,
        balanceAmount: balanceAmount.greaterThan(0) ? balanceAmount : ZERO,
        status: settled ? DocumentStatus.PAID : invoice.status,
      },
    });

    await logDocumentAction(tx, {
      companyId: auth.companyId,
      documentId: invoice.id,
      userId: auth.userId,
      action: AuditAction.PAYMENT_ALLOCATED,
      oldData: {
        paidAmount: invoice.paidAmount.toFixed(2),
        balanceAmount: invoice.balanceAmount.toFixed(2),
        status: invoice.status,
      },
      newData: {
        paidAmount: paidAmount.toFixed(2),
        balanceAmount: balanceAmount.toFixed(2),
        status: settled ? DocumentStatus.PAID : invoice.status,
        payment: payment.paymentNumber,
        allocatedAmount: amount.toFixed(2),
      },
    });

    await notifyPaymentAllocated(tx, auth, payment, invoice, amount);

    alreadyAllocated = alreadyAllocated.plus(amount);
  }
}

export async function allocatePayment(
  auth: AuthContext,
  paymentId: string,
  allocations: AllocationInput[]
) {
  await notifyingTransaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.companyId !== auth.companyId) {
      throw notFound('Payment not found');
    }
    if (payment.branchId) {
      await assertBranchAccess(auth, payment.branchId, tx);
    }
    await applyAllocations(tx, auth, paymentId, allocations);

    // Allocating is what turns a payment into a settlement of supplier liability,
    // so it is the accounting event. A payment already booked is topped up by the
    // increment rather than posted again.
    await autoPostPaymentAccounting(tx, auth, paymentId);
  }, deliverNotifications);

  return getPayment(auth, paymentId);
}

export async function getPayment(auth: AuthContext, id: string) {
  const payment = await prisma.payment.findFirst({
    where: { id, companyId: auth.companyId },
    include: {
      supplier: { select: { id: true, code: true, name: true } },
      branch: { select: { id: true, code: true, name: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      allocations: {
        include: {
          document: {
            select: {
              id: true,
              documentNumber: true,
              documentType: true,
              status: true,
            },
          },
        },
      },
    },
  });
  if (!payment) {
    throw notFound('Payment not found');
  }
  if (
    payment.branchId &&
    !auth.hasAllBranches &&
    !auth.allowedBranchIds.includes(payment.branchId)
  ) {
    throw forbidden('Access denied for this payment');
  }

  return serializePayment(payment);
}

export async function listPayments(auth: AuthContext, query: PaymentListQuery) {
  const where: Prisma.PaymentWhereInput = { companyId: auth.companyId };
  if (!auth.hasAllBranches) {
    where.branchId = { in: auth.allowedBranchIds };
  }
  if (query.branchId) {
    await assertBranchAccess(auth, query.branchId);
    where.branchId = query.branchId;
  }
  if (query.supplierId) where.supplierId = query.supplierId;
  if (query.method) where.method = query.method;
  if (query.search) {
    where.OR = [
      { paymentNumber: { contains: query.search, mode: 'insensitive' } },
      { reference: { contains: query.search, mode: 'insensitive' } },
    ];
  }
  if (query.fromDate || query.toDate) {
    where.paymentDate = {
      ...(query.fromDate ? { gte: query.fromDate } : {}),
      ...(query.toDate ? { lte: query.toDate } : {}),
    };
  }

  const [total, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      ...paginate(query),
      orderBy: { paymentDate: query.sortOrder },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        branch: { select: { id: true, code: true, name: true } },
        allocations: { select: { id: true, allocatedAmount: true } },
      },
    }),
  ]);

  return { data: rows.map(serializePayment), meta: pageMeta(query, total) };
}
