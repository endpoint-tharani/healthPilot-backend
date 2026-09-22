import { AccountMappingType, DocumentStatus, DocumentType, Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma';
import { AuthContext } from '../../context/authContext';
import { forbidden, notFound } from '../../utils/errors';
import { money, sum, ZERO } from '../../utils/decimal';
import { isBranchInScope } from '../authorization.service';
import { resolveAccountingAccount } from './accountMapping.service';
import { postedLineWhere } from './generalLedger.service';

/**
 * The accounts payable subledger.
 *
 * There is exactly one trade payables account - 2301 in the shipped Ind AS chart -
 * and it is a control account: every supplier's liability runs through it, and the
 * balance sheet reads one figure off it. A chart that instead grew 2302 MediSupply,
 * 2303 the next vendor and so on would turn the reporting format into a contact
 * list, add a Trial Balance row per trading partner, and make "what do we owe in
 * total" a pattern-match over account codes.
 *
 * So the per-supplier position is a filter over the control account's own lines,
 * keyed by the supplierId every payable line carries. The consequence is the
 * property an AP subledger is supposed to have and usually has to be reconciled
 * into: the sum of every supplier's balance IS the control account balance, by
 * construction, because they are the same rows read two ways.
 */

export interface SupplierLedgerFilters {
  supplierId?: string;
  branchId?: string;
  fromDate?: Date;
  toDate?: Date;
}

export interface SupplierLedgerRow {
  journalLineId: string;
  date: Date;
  journalEntryId: string;
  journalNumber: string;
  event: string;
  document: string | null;
  documentType: string | null;
  sourceDocumentId: string | null;
  sourcePaymentId: string | null;
  supplier: { id: string; code: string; name: string } | null;
  branch: { id: string; code: string; name: string } | null;
  description: string;
  debit: string;
  credit: string;
  runningBalance: string;
}

/**
 * One supplier's movements through the payables control account, in date order,
 * with a running balance.
 *
 * The balance is presented the way a liability reads: a credit raises what is
 * owed and a debit reduces it, so an invoice pushes the balance up and a payment
 * brings it back down. Presenting the raw debit-minus-credit would report a
 * payable of 36,750 as -36,750, which is arithmetically the same and reads as
 * though the supplier owes the company.
 *
 * The opening balance is everything before the window, so a filtered range
 * continues from where the previous period ended rather than restarting at zero.
 */
export async function getSupplierLedger(auth: AuthContext, filters: SupplierLedgerFilters) {
  const supplier = filters.supplierId
    ? await prisma.supplier.findFirst({
        where: { id: filters.supplierId, companyId: auth.companyId },
        select: { id: true, code: true, name: true },
      })
    : null;
  if (filters.supplierId && !supplier) {
    // Scoped by company on the lookup, so a supplier id from another tenant is
    // "not found" rather than a window into their ledger.
    throw notFound('Supplier not found');
  }
  if (filters.branchId && !isBranchInScope(auth, filters.branchId)) {
    throw forbidden('Access denied for this branch');
  }

  const control = await resolveAccountingAccount(
    auth.companyId,
    filters.branchId ?? null,
    AccountMappingType.VENDOR
  );

  const scoped = postedLineWhere(auth, filters);
  const where: Prisma.JournalLineWhereInput = {
    ...scoped,
    ledgerId: control.ledgerId,
    ...(filters.supplierId ? { supplierId: filters.supplierId } : { supplierId: { not: null } }),
  };

  const openingWhere: Prisma.JournalLineWhereInput = {
    ...postedLineWhere(auth, { branchId: filters.branchId, toDate: undefined }),
    ledgerId: control.ledgerId,
    ...(filters.supplierId ? { supplierId: filters.supplierId } : { supplierId: { not: null } }),
  };
  if (filters.fromDate) {
    openingWhere.journalEntry = {
      ...(openingWhere.journalEntry as Prisma.JournalEntryWhereInput),
      documentDate: { lt: filters.fromDate },
    };
  }

  const [opening, lines] = await Promise.all([
    filters.fromDate
      ? prisma.journalLine.aggregate({ where: openingWhere, _sum: { debit: true, credit: true } })
      : Promise.resolve(null),
    prisma.journalLine.findMany({
      where,
      orderBy: [
        { journalEntry: { documentDate: 'asc' } },
        { journalEntry: { journalNumber: 'asc' } },
        { lineNumber: 'asc' },
      ],
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        branch: { select: { id: true, code: true, name: true } },
        journalEntry: {
          select: {
            id: true,
            journalNumber: true,
            documentDate: true,
            event: true,
            description: true,
            sourceDocumentId: true,
            sourcePaymentId: true,
            sourceReference: true,
            sourceDocumentType: true,
          },
        },
      },
    }),
  ]);

  // Credit less debit: a payable grows on the credit side.
  let balance = opening
    ? money((opening._sum.credit ?? ZERO).minus(opening._sum.debit ?? ZERO))
    : ZERO;
  const openingBalance = balance;

  const rows: SupplierLedgerRow[] = lines.map((line) => {
    balance = money(balance.plus(line.credit).minus(line.debit));
    return {
      journalLineId: line.id,
      date: line.journalEntry.documentDate,
      journalEntryId: line.journalEntry.id,
      journalNumber: line.journalEntry.journalNumber,
      event: line.journalEntry.event,
      document: line.journalEntry.sourceReference,
      documentType: line.journalEntry.sourceDocumentType,
      sourceDocumentId: line.journalEntry.sourceDocumentId,
      sourcePaymentId: line.journalEntry.sourcePaymentId,
      supplier: line.supplier,
      branch: line.branch,
      description: line.description ?? line.journalEntry.description,
      debit: line.debit.toFixed(2),
      credit: line.credit.toFixed(2),
      runningBalance: balance.toFixed(2),
    };
  });

  const periodDebit = money(sum(lines.map((l) => l.debit)));
  const periodCredit = money(sum(lines.map((l) => l.credit)));

  return {
    supplier,
    controlAccount: {
      ledgerId: control.ledgerId,
      code: control.ledgerCode,
      name: control.ledgerName,
      headCode: control.headCode,
      headName: control.headName,
    },
    scope: {
      branchId: filters.branchId ?? null,
      fromDate: filters.fromDate ?? null,
      toDate: filters.toDate ?? null,
    },
    rows,
    openingBalance: openingBalance.toFixed(2),
    periodDebit: periodDebit.toFixed(2),
    periodCredit: periodCredit.toFixed(2),
    closingBalance: balance.toFixed(2),
  };
}

/* ------------------------------------------------------ supplier outstanding ---- */

export interface SupplierOutstandingRow {
  supplier: { id: string; code: string; name: string };
  invoiced: string;
  credited: string;
  paid: string;
  disputed: string;
  outstanding: string;
  /** The same supplier's balance on the payables control account. */
  ledgerBalance: string;
  /** Outstanding less ledger balance. Nil when the books and the workflow agree. */
  difference: string;
  reconciled: boolean;
}

/**
 * What each supplier is still owed, and whether the books agree.
 *
 * The figure itself comes from the business documents - invoices less credit
 * notes less payments - because that is where the obligation is decided, and a
 * second independent balance store is the thing this deliberately does not
 * create. What it adds is the comparison: the same position read off the posted
 * journals, and the difference between them.
 *
 * A non-zero difference is not a rounding curiosity. It means a business event
 * happened that the books never recorded, or the other way round, and it is the
 * single number that says whether the accounting integration is actually working.
 * In the standard workflow it is nil for every supplier, with one honest
 * exception: a credit note that cleared disputed value the invoice journal never
 * booked reduces the documented position without moving the ledger, because there
 * was no liability there to reduce. That is why `disputed` is reported beside it.
 */
export async function getSupplierOutstanding(
  auth: AuthContext,
  filters: { supplierId?: string; branchId?: string } = {}
): Promise<{
  controlAccount: { ledgerId: string; code: string; name: string };
  rows: SupplierOutstandingRow[];
  totals: { outstanding: string; ledgerBalance: string; difference: string };
  reconciled: boolean;
}> {
  if (filters.branchId && !isBranchInScope(auth, filters.branchId)) {
    throw forbidden('Access denied for this branch');
  }

  const control = await resolveAccountingAccount(
    auth.companyId,
    filters.branchId ?? null,
    AccountMappingType.VENDOR
  );

  const documentWhere: Prisma.DocumentWhereInput = {
    companyId: auth.companyId,
    status: { not: DocumentStatus.CANCELLED },
    supplierId: filters.supplierId ? filters.supplierId : { not: null },
    documentType: { in: [DocumentType.SUPPLIER_INVOICE, DocumentType.CREDIT_NOTE] },
  };
  if (filters.branchId) {
    documentWhere.branchId = filters.branchId;
  } else if (!auth.hasAllBranches) {
    documentWhere.OR = [{ branchId: { in: auth.allowedBranchIds } }, { branchId: null }];
  }

  const documents = await prisma.document.findMany({
    where: documentWhere,
    select: {
      supplierId: true,
      documentType: true,
      totalAmount: true,
      paidAmount: true,
      disputedAmount: true,
      supplier: { select: { id: true, code: true, name: true } },
    },
  });

  const lineWhere: Prisma.JournalLineWhereInput = {
    ...postedLineWhere(auth, { branchId: filters.branchId }),
    ledgerId: control.ledgerId,
    ...(filters.supplierId ? { supplierId: filters.supplierId } : { supplierId: { not: null } }),
  };
  const ledgerLines = await prisma.journalLine.groupBy({
    by: ['supplierId'],
    where: lineWhere,
    _sum: { debit: true, credit: true },
  });
  const ledgerBySupplier = new Map(
    ledgerLines.map((row) => [
      row.supplierId,
      money((row._sum.credit ?? ZERO).minus(row._sum.debit ?? ZERO)),
    ])
  );

  interface Accumulator {
    supplier: { id: string; code: string; name: string };
    invoiced: Prisma.Decimal;
    credited: Prisma.Decimal;
    paid: Prisma.Decimal;
    disputed: Prisma.Decimal;
  }
  const bySupplier = new Map<string, Accumulator>();

  for (const doc of documents) {
    if (!doc.supplier) {
      continue;
    }
    const entry =
      bySupplier.get(doc.supplier.id) ??
      ({
        supplier: doc.supplier,
        invoiced: ZERO,
        credited: ZERO,
        paid: ZERO,
        disputed: ZERO,
      } as Accumulator);

    if (doc.documentType === DocumentType.SUPPLIER_INVOICE) {
      entry.invoiced = entry.invoiced.plus(doc.totalAmount);
      entry.paid = entry.paid.plus(doc.paidAmount);
      entry.disputed = entry.disputed.plus(doc.disputedAmount);
    } else {
      entry.credited = entry.credited.plus(doc.totalAmount);
    }
    bySupplier.set(doc.supplier.id, entry);
  }

  // Suppliers with a ledger balance but no open document still belong in the
  // report: a difference that only exists on one side is exactly what this is for.
  for (const [supplierId] of ledgerBySupplier) {
    if (supplierId && !bySupplier.has(supplierId)) {
      const supplier = await prisma.supplier.findFirst({
        where: { id: supplierId, companyId: auth.companyId },
        select: { id: true, code: true, name: true },
      });
      if (supplier) {
        bySupplier.set(supplierId, {
          supplier,
          invoiced: ZERO,
          credited: ZERO,
          paid: ZERO,
          disputed: ZERO,
        });
      }
    }
  }

  const rows: SupplierOutstandingRow[] = [...bySupplier.values()]
    .map((entry) => {
      const outstanding = money(entry.invoiced.minus(entry.credited).minus(entry.paid));
      const ledgerBalance = ledgerBySupplier.get(entry.supplier.id) ?? ZERO;
      const difference = money(outstanding.minus(ledgerBalance));
      return {
        supplier: entry.supplier,
        invoiced: entry.invoiced.toFixed(2),
        credited: entry.credited.toFixed(2),
        paid: entry.paid.toFixed(2),
        disputed: entry.disputed.toFixed(2),
        outstanding: outstanding.toFixed(2),
        ledgerBalance: ledgerBalance.toFixed(2),
        difference: difference.toFixed(2),
        reconciled: difference.isZero(),
      };
    })
    .sort((a, b) => a.supplier.code.localeCompare(b.supplier.code));

  const totalOutstanding = money(sum(rows.map((r) => r.outstanding)));
  const totalLedger = money(sum(rows.map((r) => r.ledgerBalance)));

  return {
    controlAccount: {
      ledgerId: control.ledgerId,
      code: control.ledgerCode,
      name: control.ledgerName,
    },
    rows,
    totals: {
      outstanding: totalOutstanding.toFixed(2),
      ledgerBalance: totalLedger.toFixed(2),
      difference: money(totalOutstanding.minus(totalLedger)).toFixed(2),
    },
    reconciled: rows.every((r) => r.reconciled),
  };
}
