import { JournalStatus, Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma';
import { AuthContext } from '../../context/authContext';
import { notFound } from '../../utils/errors';
import { money, ZERO } from '../../utils/decimal';
import { isBranchInScope } from '../authorization.service';
import { forbidden } from '../../utils/errors';

export interface GeneralLedgerFilters {
  ledgerId?: string;
  branchId?: string;
  fromDate?: Date;
  toDate?: Date;
  page: number;
  limit: number;
}

/**
 * Scope for every accounting read.
 *
 * Drafts are excluded: a draft is a working paper, and letting one reach the
 * ledger would put figures nobody has committed to into the Trial Balance.
 *
 * REVERSED entries are deliberately *included*. A reversed journal is one that
 * was posted and has since been cancelled by a mirror entry, and that mirror is
 * itself POSTED - so dropping the original while keeping the mirror does not
 * cancel the posting, it applies the opposite of it. A 400 credit reversed would
 * report as a 400 debit rather than as nothing, which is how this was found:
 * revenue came out 28.00 higher than the sales actually made. Both rows stay, the
 * pair nets to zero, and the general ledger shows that a correction happened
 * instead of quietly erasing it.
 */
const IN_THE_LEDGER: JournalStatus[] = [JournalStatus.POSTED, JournalStatus.REVERSED];

export function postedLineWhere(
  auth: AuthContext,
  filters: { branchId?: string; fromDate?: Date; toDate?: Date }
): Prisma.JournalLineWhereInput {
  const entry: Prisma.JournalEntryWhereInput = {
    companyId: auth.companyId,
    status: { in: IN_THE_LEDGER },
  };

  if (filters.fromDate || filters.toDate) {
    entry.documentDate = {
      ...(filters.fromDate ? { gte: filters.fromDate } : {}),
      ...(filters.toDate ? { lte: filters.toDate } : {}),
    };
  }

  const where: Prisma.JournalLineWhereInput = { journalEntry: entry };

  // Branch scope is applied to the line rather than the entry, because a single
  // journal may carry lines for more than one branch and a branch report must show
  // its own lines, not every line of any journal that touched it.
  if (filters.branchId) {
    if (!isBranchInScope(auth, filters.branchId)) {
      throw forbidden('Access denied for this branch');
    }
    where.branchId = filters.branchId;
  } else if (!auth.hasAllBranches) {
    where.OR = [{ branchId: { in: auth.allowedBranchIds } }, { branchId: null }];
  }

  return where;
}

export interface GeneralLedgerRow {
  journalLineId: string;
  date: Date;
  journalEntryId: string;
  journalNumber: string;
  event: string;
  sourceDocumentId: string | null;
  sourceDocument: string | null;
  sourceDocumentType: string | null;
  branch: { id: string; code: string; name: string } | null;
  description: string;
  debit: string;
  credit: string;
  runningBalance: string;
}

/**
 * The movements on one account, in date order, with a running balance.
 *
 * The balance is computed from the journal lines on every read rather than stored
 * on the ledger. A stored balance is a second copy of a number the lines already
 * determine, and the two drift the first time a posting is reversed or a line is
 * repaired - at which point nobody can say which is right. This is the same rule
 * the stock side already follows: the ledger is the truth, not a balance table
 * beside it.
 *
 * The opening balance is the sum of everything before the window, so page two of
 * a filtered range continues from page one rather than restarting at zero.
 */
export async function getGeneralLedger(auth: AuthContext, filters: GeneralLedgerFilters) {
  if (!filters.ledgerId) {
    throw notFound('A ledger account is required for the general ledger');
  }

  const ledger = await prisma.ledger.findFirst({
    where: { id: filters.ledgerId, companyId: auth.companyId },
    include: {
      head: { include: { natureType: { include: { nature: true } } } },
    },
  });
  if (!ledger) {
    throw notFound('Ledger not found');
  }

  const scoped = postedLineWhere(auth, filters);
  const where: Prisma.JournalLineWhereInput = { ...scoped, ledgerId: ledger.id };

  // Everything before the window, so the running balance starts where the last
  // period left off instead of at zero.
  const openingWhere: Prisma.JournalLineWhereInput = {
    ...postedLineWhere(auth, { branchId: filters.branchId, toDate: undefined }),
    ledgerId: ledger.id,
  };
  if (filters.fromDate) {
    openingWhere.journalEntry = {
      ...(openingWhere.journalEntry as Prisma.JournalEntryWhereInput),
      documentDate: { lt: filters.fromDate },
    };
  }

  const [openingAgg, total, rows] = await Promise.all([
    filters.fromDate
      ? prisma.journalLine.aggregate({ where: openingWhere, _sum: { debit: true, credit: true } })
      : Promise.resolve(null),
    prisma.journalLine.count({ where }),
    prisma.journalLine.findMany({
      where,
      orderBy: [
        { journalEntry: { documentDate: 'asc' } },
        { journalEntry: { journalNumber: 'asc' } },
        { lineNumber: 'asc' },
      ],
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: {
        branch: { select: { id: true, code: true, name: true } },
        journalEntry: {
          select: {
            id: true,
            journalNumber: true,
            documentDate: true,
            event: true,
            description: true,
            sourceDocumentId: true,
            sourceDocumentType: true,
            sourceReference: true,
          },
        },
      },
    }),
  ]);

  // Debit-natured accounts (assets, expenses) increase on the debit side;
  // credit-natured ones (liabilities, equity, income) on the credit side. Showing
  // one signed column for both would make every liability read as negative.
  const debitNatured = ledger.openingBalanceType === 'DR';
  const signed = (debit: Prisma.Decimal, credit: Prisma.Decimal) =>
    debitNatured ? debit.minus(credit) : credit.minus(debit);

  let running = openingAgg
    ? signed(openingAgg._sum.debit ?? ZERO, openingAgg._sum.credit ?? ZERO)
    : ZERO;

  // Rows already skipped on earlier pages still have to move the balance, or page
  // two would open at the first page's starting figure.
  if (filters.page > 1) {
    const skippedRows = await prisma.journalLine.findMany({
      where,
      orderBy: [
        { journalEntry: { documentDate: 'asc' } },
        { journalEntry: { journalNumber: 'asc' } },
        { lineNumber: 'asc' },
      ],
      take: (filters.page - 1) * filters.limit,
      select: { debit: true, credit: true },
    });
    for (const row of skippedRows) {
      running = running.plus(signed(row.debit, row.credit));
    }
  }

  const openingBalance = money(running);

  const data: GeneralLedgerRow[] = rows.map((row) => {
    running = running.plus(signed(row.debit, row.credit));
    return {
      journalLineId: row.id,
      date: row.journalEntry.documentDate,
      journalEntryId: row.journalEntry.id,
      journalNumber: row.journalEntry.journalNumber,
      event: row.journalEntry.event,
      sourceDocumentId: row.journalEntry.sourceDocumentId,
      sourceDocument: row.journalEntry.sourceReference,
      sourceDocumentType: row.journalEntry.sourceDocumentType,
      branch: row.branch,
      description: row.description ?? row.journalEntry.description,
      debit: row.debit.toFixed(2),
      credit: row.credit.toFixed(2),
      runningBalance: money(running).toFixed(2),
    };
  });

  const periodTotals = await prisma.journalLine.aggregate({
    where,
    _sum: { debit: true, credit: true },
  });

  return {
    ledger: {
      id: ledger.id,
      code: ledger.code,
      name: ledger.name,
      openingBalanceType: ledger.openingBalanceType,
      head: { code: ledger.head.code, name: ledger.head.name },
      nature: {
        code: ledger.head.natureType.nature.code,
        name: ledger.head.natureType.nature.name,
      },
    },
    openingBalance: openingBalance.toFixed(2),
    closingBalance: money(running).toFixed(2),
    periodDebit: money(periodTotals._sum.debit ?? ZERO).toFixed(2),
    periodCredit: money(periodTotals._sum.credit ?? ZERO).toFixed(2),
    data,
    meta: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.ceil(total / filters.limit) || 0,
    },
  };
}

export interface LedgerBalance {
  ledgerId: string;
  code: string;
  name: string;
  headCode: string;
  headName: string;
  natureTypeCode: string;
  natureTypeName: string;
  natureCode: string;
  natureName: string;
  openingBalanceType: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  /** debit - credit. Positive is a debit balance, negative a credit balance. */
  net: Prisma.Decimal;
}

/**
 * Every ledger's movement in a period, with its place in the reporting hierarchy.
 *
 * One grouped aggregate plus one chart read, rather than a query per account:
 * a Trial Balance over a few hundred ledgers would otherwise issue a few hundred
 * round trips to a network database.
 */
export async function getLedgerBalances(
  auth: AuthContext,
  filters: { branchId?: string; fromDate?: Date; toDate?: Date }
): Promise<LedgerBalance[]> {
  const where = postedLineWhere(auth, filters);

  const [grouped, ledgers] = await Promise.all([
    prisma.journalLine.groupBy({
      by: ['ledgerId'],
      where,
      _sum: { debit: true, credit: true },
    }),
    prisma.ledger.findMany({
      where: { companyId: auth.companyId },
      include: { head: { include: { natureType: { include: { nature: true } } } } },
      orderBy: { code: 'asc' },
    }),
  ]);

  const movementByLedger = new Map(grouped.map((row) => [row.ledgerId, row._sum]));

  return ledgers
    .map((ledger) => {
      const movement = movementByLedger.get(ledger.id);
      const debit = money(movement?.debit ?? ZERO);
      const credit = money(movement?.credit ?? ZERO);
      return {
        ledgerId: ledger.id,
        code: ledger.code,
        name: ledger.name,
        headCode: ledger.head.code,
        headName: ledger.head.name,
        natureTypeCode: ledger.head.natureType.code,
        natureTypeName: ledger.head.natureType.name,
        natureCode: ledger.head.natureType.nature.code,
        natureName: ledger.head.natureType.nature.name,
        openingBalanceType: ledger.openingBalanceType,
        debit,
        credit,
        net: money(debit.minus(credit)),
      };
    })
    // Accounts with no movement in the window are left out: a Trial Balance
    // listing three hundred empty rows hides the dozen that matter.
    .filter((row) => !row.debit.isZero() || !row.credit.isZero());
}
