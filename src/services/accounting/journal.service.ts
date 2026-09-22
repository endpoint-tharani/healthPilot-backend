import {
  AccountingEvent,
  JournalSourceType,
  JournalStatus,
  Prisma,
} from '@prisma/client';
import { prisma, transaction } from '../../database/prisma';
import { AuthContext } from '../../context/authContext';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { dec, DecimalInput, money, sum, ZERO } from '../../utils/decimal';
import { logger } from '../../loggers';
import { JOURNAL_NUMBER_PREFIX, JOURNAL_SEQUENCE_WIDTH } from '../../constants/accounting';
import { isBranchInScope } from '../authorization.service';

/* -------------------------------------------------------------- numbering ---- */

/**
 * Journal numbers are serialised per company with a transaction-scoped advisory
 * lock, exactly as document and payment numbers are. Two postings racing for
 * JV-0007 would otherwise both read the same maximum and one would fail the
 * unique key, turning a routine concurrent post into a lost transaction.
 */
async function nextJournalNumber(
  tx: Prisma.TransactionClient,
  companyId: string
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${companyId + ':JOURNAL'}))`;

  const last = await tx.journalEntry.findFirst({
    where: { companyId },
    orderBy: { journalNumber: 'desc' },
    select: { journalNumber: true },
  });
  const sequence = last ? (parseInt(last.journalNumber.split('-').pop() ?? '0', 10) || 0) + 1 : 1;
  return JOURNAL_NUMBER_PREFIX + '-' + String(sequence).padStart(JOURNAL_SEQUENCE_WIDTH, '0');
}

/* ------------------------------------------------------------ the posting ---- */

export interface JournalLineInput {
  ledgerId: string;
  debit?: DecimalInput;
  credit?: DecimalInput;
  description?: string;
  branchId?: string | null;
  /**
   * The supplier a payable line is attributable to. Set on the control-account
   * side of every supplier posting and nowhere else, which is what makes the
   * accounts payable subledger a filter over the control account's own lines
   * rather than a second set of accounts beside it.
   */
  supplierId?: string | null;
  reference?: string;
}

export interface PostJournalInput {
  companyId: string;
  branchId: string | null;
  documentDate: Date;
  event: AccountingEvent;
  /** Per-company identity of the business event. The idempotency key. */
  sourceEventKey: string;
  sourceType?: JournalSourceType;
  sourceDocumentId?: string | null;
  sourcePaymentId?: string | null;
  sourceDocumentType?: string | null;
  sourceReference?: string | null;
  description: string;
  lines: JournalLineInput[];
  /** DRAFT builds the entry without it reaching any report. Defaults to POSTED. */
  status?: JournalStatus;
}

export interface ValidatedLine {
  lineNumber: number;
  ledgerId: string;
  branchId: string | null;
  supplierId: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string | null;
  reference: string | null;
}

export interface ValidatedJournal {
  lines: ValidatedLine[];
  totalDebit: Prisma.Decimal;
  totalCredit: Prisma.Decimal;
}

/**
 * The double-entry rules, applied before anything is written.
 *
 * Every one of these is also a CHECK constraint or a unique index in Postgres.
 * They are repeated here not out of distrust of the database but because a
 * constraint violation surfaces as "23514 JournalLine_exactly_one_side", which
 * tells an operator nothing about which line of which posting is wrong. The
 * database is the guarantee; this is the explanation.
 */
export function validateJournalLines(lines: JournalLineInput[]): ValidatedJournal {
  if (lines.length < 2) {
    throw badRequest('A journal entry needs at least two lines, got ' + lines.length);
  }

  const validated: ValidatedLine[] = lines.map((line, index) => {
    const lineNumber = index + 1;
    const debit = money(line.debit ?? ZERO);
    const credit = money(line.credit ?? ZERO);

    if (debit.lessThan(0) || credit.lessThan(0)) {
      throw badRequest(
        'Line ' + lineNumber + ': debit and credit must not be negative. ' +
          'A negative debit is a credit with the wrong sign, and unbalances every report that sums the columns separately.'
      );
    }
    if (debit.greaterThan(0) && credit.greaterThan(0)) {
      throw badRequest(
        'Line ' + lineNumber + ': a line carries either a debit or a credit, never both'
      );
    }
    if (debit.isZero() && credit.isZero()) {
      throw badRequest('Line ' + lineNumber + ': a line must carry a debit or a credit');
    }
    if (!line.ledgerId) {
      throw badRequest('Line ' + lineNumber + ': a ledger account is required');
    }

    return {
      lineNumber,
      ledgerId: line.ledgerId,
      branchId: line.branchId ?? null,
      supplierId: line.supplierId ?? null,
      debit,
      credit,
      description: line.description ?? null,
      reference: line.reference ?? null,
    };
  });

  const totalDebit = money(sum(validated.map((l) => l.debit)));
  const totalCredit = money(sum(validated.map((l) => l.credit)));

  if (!totalDebit.equals(totalCredit)) {
    throw badRequest(
      'Journal does not balance: debit ' +
        totalDebit.toFixed(2) +
        ' against credit ' +
        totalCredit.toFixed(2) +
        ' (difference ' +
        totalDebit.minus(totalCredit).toFixed(2) +
        ')'
    );
  }
  if (totalDebit.isZero()) {
    throw badRequest('Journal totals zero on both sides and records nothing');
  }

  return { lines: validated, totalDebit, totalCredit };
}

/** Postgres unique-violation, which is how a duplicate posting arrives here. */
function isUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export interface PostJournalResult {
  journalEntryId: string;
  journalNumber: string;
  /** True when the event had already been posted and the existing entry was returned. */
  alreadyPosted: boolean;
}

/**
 * Writes one journal entry, or returns the one that already exists for the event.
 *
 * Duplicate accounting is prevented by the unique index on
 * (companyId, sourceEventKey) rather than by looking first and inserting after.
 * The difference matters under concurrency: two requests to post the same
 * supplier invoice can both pass a check-then-insert, because both read "not
 * posted yet" before either writes. Here they both attempt the insert, Postgres
 * lets exactly one through, and the loser catches the violation and returns the
 * winner's entry. The caller cannot tell the difference, and the books only ever
 * get one copy.
 *
 * The lookup before the insert is not the guard - it is an optimisation so the
 * common retry does not have to burn a failed transaction.
 */
export async function postJournal(
  auth: AuthContext,
  input: PostJournalInput,
  tx?: Prisma.TransactionClient
): Promise<PostJournalResult> {
  if (input.companyId !== auth.companyId) {
    throw forbidden('Cannot post a journal for another company');
  }

  const validated = validateJournalLines(input.lines);
  const status = input.status ?? JournalStatus.POSTED;

  const run = async (db: Prisma.TransactionClient): Promise<PostJournalResult> => {
    const existing = await db.journalEntry.findUnique({
      where: {
        companyId_sourceEventKey: {
          companyId: input.companyId,
          sourceEventKey: input.sourceEventKey,
        },
      },
      select: { id: true, journalNumber: true },
    });
    if (existing) {
      return {
        journalEntryId: existing.id,
        journalNumber: existing.journalNumber,
        alreadyPosted: true,
      };
    }

    // Every ledger is checked to belong to this company. Without it, a caller
    // holding a ledger id from another tenant could write a line into their
    // chart, and that line would then appear in that tenant's Trial Balance.
    const ledgerIds = [...new Set(validated.lines.map((l) => l.ledgerId))];
    const ledgers = await db.ledger.findMany({
      where: { id: { in: ledgerIds }, companyId: input.companyId },
      select: { id: true, isActive: true, code: true },
    });
    if (ledgers.length !== ledgerIds.length) {
      throw notFound('One or more ledger accounts do not belong to this company');
    }
    const inactive = ledgers.filter((l) => !l.isActive);
    if (inactive.length > 0) {
      throw conflict(
        'Cannot post to inactive ledger account(s): ' + inactive.map((l) => l.code).join(', ')
      );
    }

    const journalNumber = await nextJournalNumber(db, input.companyId);

    const entry = await db.journalEntry.create({
      data: {
        companyId: input.companyId,
        branchId: input.branchId,
        journalNumber,
        documentDate: input.documentDate,
        event: input.event,
        sourceType: input.sourceType ?? JournalSourceType.MANUAL,
        sourceEventKey: input.sourceEventKey,
        sourceDocumentId: input.sourceDocumentId ?? null,
        sourcePaymentId: input.sourcePaymentId ?? null,
        sourceDocumentType: input.sourceDocumentType ?? null,
        sourceReference: input.sourceReference ?? null,
        description: input.description,
        status,
        totalDebit: validated.totalDebit,
        totalCredit: validated.totalCredit,
        createdById: auth.userId,
        postedById: status === JournalStatus.POSTED ? auth.userId : null,
        postedAt: status === JournalStatus.POSTED ? new Date() : null,
        lines: {
          create: validated.lines.map((line) => ({
            lineNumber: line.lineNumber,
            ledgerId: line.ledgerId,
            branchId: line.branchId ?? input.branchId,
            supplierId: line.supplierId,
            debit: line.debit,
            credit: line.credit,
            description: line.description,
            reference: line.reference,
          })),
        },
      },
      select: { id: true, journalNumber: true },
    });

    return { journalEntryId: entry.id, journalNumber: entry.journalNumber, alreadyPosted: false };
  };

  try {
    const result = tx ? await run(tx) : await transaction(run);
    if (!result.alreadyPosted) {
      logger.info('Journal posted', {
        companyId: input.companyId,
        journalNumber: result.journalNumber,
        event: input.event,
        sourceEventKey: input.sourceEventKey,
        debit: validated.totalDebit.toFixed(2),
      });
    }
    return result;
  } catch (error) {
    // The concurrent-post case: the other transaction won the unique key. Its
    // entry is the one true posting, so it is returned rather than retried.
    if (isUniqueViolation(error)) {
      const winner = await prisma.journalEntry.findUnique({
        where: {
          companyId_sourceEventKey: {
            companyId: input.companyId,
            sourceEventKey: input.sourceEventKey,
          },
        },
        select: { id: true, journalNumber: true },
      });
      if (winner) {
        logger.info('Duplicate journal refused by the unique key; existing entry returned', {
          companyId: input.companyId,
          sourceEventKey: input.sourceEventKey,
          journalNumber: winner.journalNumber,
        });
        return {
          journalEntryId: winner.id,
          journalNumber: winner.journalNumber,
          alreadyPosted: true,
        };
      }
    }
    throw error;
  }
}

/* ---------------------------------------------------------------- reversal ---- */

/**
 * Cancels a posted journal by raising its mirror image, and never by editing it.
 *
 * Posted accounting is history. Editing a posted entry - or deleting it - would
 * change what the books said about a period that has already been reported on,
 * and leave no trace that it ever said anything different. A reversal states the
 * correction as its own dated, attributable event, which is what makes the trail
 * auditable: both entries remain, and the net effect is nil.
 *
 * The reversal carries its own idempotency key, so a retried correction produces
 * one reversal rather than a second one that would re-open the original.
 */
export async function reverseJournalEntry(
  auth: AuthContext,
  journalEntryId: string,
  reason: string,
  options: { documentDate?: Date } = {}
): Promise<PostJournalResult> {
  if (!reason?.trim()) {
    throw badRequest('A reason is required to reverse a journal entry');
  }

  const original = await prisma.journalEntry.findUnique({
    where: { id: journalEntryId },
    include: { lines: { orderBy: { lineNumber: 'asc' } }, reversedBy: true },
  });
  if (!original || original.companyId !== auth.companyId) {
    throw notFound('Journal entry not found');
  }
  if (original.status === JournalStatus.DRAFT) {
    throw conflict(
      'Journal ' + original.journalNumber + ' is a draft. Delete it rather than reversing it.'
    );
  }
  if (original.status === JournalStatus.REVERSED) {
    throw conflict('Journal ' + original.journalNumber + ' has already been reversed');
  }
  if (original.branchId && !isBranchInScope(auth, original.branchId)) {
    throw forbidden('Access denied for this branch');
  }

  const reversalKey = 'REVERSAL:' + original.id;

  return transaction(async (tx) => {
    const result = await postJournal(
      auth,
      {
        companyId: original.companyId,
        branchId: original.branchId,
        // Dated today by default: a reversal is a new event, and back-dating it
        // into a reported period would silently restate that period.
        documentDate: options.documentDate ?? new Date(),
        event: AccountingEvent.REVERSAL,
        sourceEventKey: reversalKey,
        sourceType: original.sourceType,
        sourceDocumentId: original.sourceDocumentId,
        sourcePaymentId: original.sourcePaymentId,
        sourceDocumentType: original.sourceDocumentType,
        sourceReference: original.sourceReference,
        description: 'Reversal of ' + original.journalNumber + ': ' + reason.trim(),
        lines: original.lines.map((line) => ({
          ledgerId: line.ledgerId,
          // The mirror image: every debit becomes a credit and the reverse.
          debit: line.credit,
          credit: line.debit,
          branchId: line.branchId,
          // Mirrored as well: a reversal that dropped the supplier would clear the
          // control account while leaving the subledger showing the old balance.
          supplierId: line.supplierId,
          description: 'Reversal of ' + original.journalNumber,
          reference: line.reference ?? undefined,
        })),
      },
      tx
    );

    if (!result.alreadyPosted) {
      // Conditional on the current status, so two concurrent reversals cannot both
      // mark the original reversed and leave two mirror entries behind.
      const marked = await tx.journalEntry.updateMany({
        where: { id: original.id, status: JournalStatus.POSTED },
        data: { status: JournalStatus.REVERSED },
      });
      if (marked.count === 0) {
        throw conflict(
          'Journal ' + original.journalNumber + ' changed status while being reversed'
        );
      }
      await tx.journalEntry.update({
        where: { id: result.journalEntryId },
        data: { reversalOfId: original.id },
      });
    }

    return result;
  });
}

/* ------------------------------------------------------------------ reads ---- */

export interface JournalListFilters {
  page: number;
  limit: number;
  branchId?: string;
  status?: JournalStatus;
  event?: AccountingEvent;
  sourceDocumentId?: string;
  fromDate?: Date;
  toDate?: Date;
  search?: string;
}

/**
 * Company and branch scope are applied to the query, never to the result set,
 * which is the rule the rest of the ERP follows. Filtering after the fetch would
 * make page counts wrong and, worse, would still have read another branch's rows.
 */
export function journalScopeWhere(
  auth: AuthContext,
  requestedBranchId?: string
): Prisma.JournalEntryWhereInput {
  const where: Prisma.JournalEntryWhereInput = { companyId: auth.companyId };

  if (requestedBranchId) {
    if (!isBranchInScope(auth, requestedBranchId)) {
      throw forbidden('Access denied for this branch');
    }
    where.branchId = requestedBranchId;
    return where;
  }
  if (!auth.hasAllBranches) {
    // Company-level entries carry no branch and stay visible; everything else is
    // limited to the branches this user holds.
    where.OR = [{ branchId: { in: auth.allowedBranchIds } }, { branchId: null }];
  }
  return where;
}

export async function listJournalEntries(auth: AuthContext, filters: JournalListFilters) {
  const where = journalScopeWhere(auth, filters.branchId);
  if (filters.status) {
    where.status = filters.status;
  }
  if (filters.event) {
    where.event = filters.event;
  }
  if (filters.sourceDocumentId) {
    where.sourceDocumentId = filters.sourceDocumentId;
  }
  if (filters.fromDate || filters.toDate) {
    where.documentDate = {
      ...(filters.fromDate ? { gte: filters.fromDate } : {}),
      ...(filters.toDate ? { lte: filters.toDate } : {}),
    };
  }
  if (filters.search) {
    where.AND = [
      {
        OR: [
          { journalNumber: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } },
          { sourceReference: { contains: filters.search, mode: 'insensitive' } },
        ],
      },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findMany({
      where,
      orderBy: [{ documentDate: 'desc' }, { journalNumber: 'desc' }],
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: {
        branch: { select: { id: true, code: true, name: true } },
        sourceDocument: { select: { id: true, documentNumber: true, documentType: true } },
        sourcePayment: { select: { id: true, paymentNumber: true } },
      },
    }),
  ]);

  return {
    data: rows.map(serializeJournalHeader),
    meta: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.ceil(total / filters.limit) || 0,
    },
  };
}

type JournalHeaderRow = Prisma.JournalEntryGetPayload<{
  include: {
    branch: { select: { id: true; code: true; name: true } };
    sourceDocument: { select: { id: true; documentNumber: true; documentType: true } };
    sourcePayment: { select: { id: true; paymentNumber: true } };
  };
}>;

function serializeJournalHeader(row: JournalHeaderRow) {
  return {
    id: row.id,
    journalNumber: row.journalNumber,
    documentDate: row.documentDate,
    event: row.event,
    status: row.status,
    description: row.description,
    branch: row.branch,
    totalDebit: row.totalDebit.toFixed(2),
    totalCredit: row.totalCredit.toFixed(2),
    isBalanced: row.totalDebit.equals(row.totalCredit),
    sourceDocument: row.sourceDocument,
    sourcePayment: row.sourcePayment,
    sourceDocumentType: row.sourceDocumentType,
    sourceReference: row.sourceReference,
    postedAt: row.postedAt,
    createdAt: row.createdAt,
  };
}

export async function getJournalEntry(auth: AuthContext, id: string) {
  const entry = await prisma.journalEntry.findUnique({
    where: { id },
    include: {
      branch: { select: { id: true, code: true, name: true } },
      sourceDocument: { select: { id: true, documentNumber: true, documentType: true } },
      sourcePayment: { select: { id: true, paymentNumber: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      postedBy: { select: { id: true, name: true, email: true } },
      reversalOf: { select: { id: true, journalNumber: true } },
      reversedBy: { select: { id: true, journalNumber: true } },
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          ledger: {
            select: {
              id: true,
              code: true,
              name: true,
              head: { select: { code: true, name: true } },
            },
          },
          branch: { select: { id: true, code: true, name: true } },
          supplier: { select: { id: true, code: true, name: true } },
        },
      },
    },
  });

  if (!entry || entry.companyId !== auth.companyId) {
    throw notFound('Journal entry not found');
  }
  if (entry.branchId && !isBranchInScope(auth, entry.branchId)) {
    throw forbidden('Access denied for this journal entry');
  }

  return {
    ...serializeJournalHeader(entry),
    createdBy: entry.createdBy,
    postedBy: entry.postedBy,
    reversalOf: entry.reversalOf,
    reversedBy: entry.reversedBy,
    sourceEventKey: entry.sourceEventKey,
    lines: entry.lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      ledger: {
        id: line.ledger.id,
        code: line.ledger.code,
        name: line.ledger.name,
        head: line.ledger.head,
      },
      branch: line.branch,
      // The subledger the line belongs to, shown beside the control account so a
      // reader of JV-0001 can see which supplier the payable is owed to without
      // leaving the journal for the supplier ledger.
      supplier: line.supplier,
      debit: line.debit.toFixed(2),
      credit: line.credit.toFixed(2),
      description: line.description,
      reference: line.reference,
    })),
  };
}

/** Journals raised for one business document, for the document detail page. */
export async function getJournalsForDocument(auth: AuthContext, documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, companyId: true },
  });
  if (!document || document.companyId !== auth.companyId) {
    throw notFound('Document not found');
  }

  const where = journalScopeWhere(auth);
  where.sourceDocumentId = documentId;

  const rows = await prisma.journalEntry.findMany({
    where,
    orderBy: [{ documentDate: 'asc' }, { journalNumber: 'asc' }],
    include: {
      branch: { select: { id: true, code: true, name: true } },
      sourceDocument: { select: { id: true, documentNumber: true, documentType: true } },
      sourcePayment: { select: { id: true, paymentNumber: true } },
    },
  });
  return rows.map(serializeJournalHeader);
}

/**
 * Journals raised for one payment.
 *
 * The counterpart of `getJournalsForDocument`, and separate from it because a
 * payment is not a Document: it carries its own source link on the journal, and
 * a supplier settlement would otherwise be reachable only from the invoices it
 * happened to settle.
 */
export async function getJournalsForPayment(auth: AuthContext, paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, companyId: true, branchId: true },
  });
  if (!payment || payment.companyId !== auth.companyId) {
    throw notFound('Payment not found');
  }
  if (payment.branchId && !isBranchInScope(auth, payment.branchId)) {
    throw forbidden('Access denied for this payment');
  }

  const where = journalScopeWhere(auth);
  where.sourcePaymentId = paymentId;

  const rows = await prisma.journalEntry.findMany({
    where,
    orderBy: [{ documentDate: 'asc' }, { journalNumber: 'asc' }],
    include: {
      branch: { select: { id: true, code: true, name: true } },
      sourceDocument: { select: { id: true, documentNumber: true, documentType: true } },
      sourcePayment: { select: { id: true, paymentNumber: true } },
    },
  });
  return rows.map(serializeJournalHeader);
}

/**
 * Posted journals are immutable. The only lawful change is a reversal, so these
 * exist to make that refusal explicit wherever an edit or delete is attempted.
 */
export function assertJournalMutable(entry: { journalNumber: string; status: JournalStatus }) {
  if (entry.status !== JournalStatus.DRAFT) {
    throw conflict(
      'Journal ' +
        entry.journalNumber +
        ' is ' +
        entry.status +
        ' and cannot be changed. Raise a reversing entry instead.'
    );
  }
}

export async function deleteDraftJournal(auth: AuthContext, id: string): Promise<void> {
  const entry = await prisma.journalEntry.findUnique({
    where: { id },
    select: { id: true, companyId: true, journalNumber: true, status: true, branchId: true },
  });
  if (!entry || entry.companyId !== auth.companyId) {
    throw notFound('Journal entry not found');
  }
  if (entry.branchId && !isBranchInScope(auth, entry.branchId)) {
    throw forbidden('Access denied for this journal entry');
  }
  assertJournalMutable(entry);

  // Conditional on DRAFT, so an entry posted between the read and the write is
  // not deleted out from under the posting.
  const deleted = await prisma.journalEntry.deleteMany({
    where: { id, companyId: auth.companyId, status: JournalStatus.DRAFT },
  });
  if (deleted.count === 0) {
    throw conflict('Journal ' + entry.journalNumber + ' was posted before it could be deleted');
  }
}

export { dec };
