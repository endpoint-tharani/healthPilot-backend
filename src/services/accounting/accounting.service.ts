import {
  AccountingEvent,
  AccountingStatus,
  AccountMappingType,
  DocumentLinkType,
  DocumentStatus,
  DocumentType,
  InventoryTransactionType,
  JournalSourceType,
  JournalStatus,
  Prisma,
} from '@prisma/client';
import { Database, prisma, transaction } from '../../database/prisma';
import { AuthContext } from '../../context/authContext';
import { conflict, forbidden, notFound } from '../../utils/errors';
import { money, sum, ZERO } from '../../utils/decimal';
import {
  accountingEventKey,
  AccountingAuditAction,
  paymentAllocationEventKey,
} from '../../constants/accounting';
import { logDocumentAction } from '../audit.service';
import { assertBranchAccess } from '../authorization.service';
import { computeInvoiceFinancials } from '../invoiceFinancials';
import { resolveAccountingAccount, resolveTaxAccount, assertCompanyAccountingReady } from './accountMapping.service';
import { JournalLineInput, PostJournalResult, postJournal } from './journal.service';

/* ------------------------------------------------------------------ shared ---- */

/**
 * Where a posting reads from, and how it writes.
 *
 * Every posting function can be called two ways, and the difference is the whole
 * of the atomicity story.
 *
 * Called on its own - from the retry endpoint, a script, a manual post - it reads
 * outside a transaction and opens a short one to write. Keeping the lookups
 * outside matters: a posting that writes three rows was spending a 60 second
 * transaction budget on reads against a serverless database and expiring before
 * it wrote anything. Correctness does not depend on them being inside, because
 * the unique key on the accounting event is what guarantees one journal per
 * event - a racing posting loses on the key, not on isolation.
 *
 * Called with a transaction client - from the business service that is creating
 * the document - it reads and writes on that client, so the journal commits with
 * the invoice or not at all. The reads have to move inside too: the document
 * being booked does not exist outside the transaction that just created it.
 */
interface PostingContext {
  read: Database;
  write: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
}

function postingContext(tx?: Prisma.TransactionClient): PostingContext {
  if (tx) {
    return { read: tx, write: (fn) => fn(tx) };
  }
  return { read: prisma, write: (fn) => transaction(fn) };
}

/**
 * Records on the source row where it stands with the books.
 *
 * Written in the same transaction as the journal, so the two can never disagree.
 * A document reading POSTED has an entry behind it; one reading PENDING does not,
 * and carries the reason why.
 */
export async function markDocumentAccounting(
  tx: Prisma.TransactionClient,
  documentId: string,
  status: AccountingStatus,
  message: string | null
): Promise<void> {
  await tx.document.update({
    where: { id: documentId },
    data: {
      accountingStatus: status,
      accountingMessage: message,
      accountingPostedAt: status === AccountingStatus.POSTED ? new Date() : null,
    },
  });
}

export async function markPaymentAccounting(
  tx: Prisma.TransactionClient,
  paymentId: string,
  status: AccountingStatus,
  message: string | null
): Promise<void> {
  await tx.payment.update({
    where: { id: paymentId },
    data: {
      accountingStatus: status,
      accountingMessage: message,
      accountingPostedAt: status === AccountingStatus.POSTED ? new Date() : null,
    },
  });
}

async function loadDocument(
  auth: AuthContext,
  documentId: string,
  expectedType: DocumentType,
  db: Database
) {
  const document = await db.document.findUnique({
    where: { id: documentId },
    include: { lineItems: { orderBy: { lineNumber: 'asc' } }, supplier: true },
  });
  if (!document || document.companyId !== auth.companyId || document.documentType !== expectedType) {
    throw notFound(expectedType.replace(/_/g, ' ').toLowerCase() + ' not found');
  }
  if (document.status === DocumentStatus.CANCELLED) {
    throw conflict(
      'Cannot post accounting for cancelled document ' + document.documentNumber
    );
  }
  if (document.branchId) {
    await assertBranchAccess(auth, document.branchId, db);
  }
  return document;
}

/** Records on the source document that its accounting was raised, and by whom. */
async function logAccountingPosted(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  documentId: string,
  result: PostJournalResult,
  detail: Record<string, string>
) {
  if (result.alreadyPosted) {
    return;
  }
  await logDocumentAction(tx, {
    companyId: auth.companyId,
    documentId,
    userId: auth.userId,
    action: AccountingAuditAction.ACCOUNTING_POSTED,
    newData: { journalNumber: result.journalNumber, ...detail },
  });
}

/* --------------------------------------------------- supplier invoice (P9) ---- */

/**
 * Books what the company actually owes the supplier.
 *
 * The amount is the accepted payable, not the invoice total. The supplier billed
 * for 100 vials; 20 arrived damaged and 10 never arrived, so 70 were accepted and
 * 36,750 is owed against the 52,500 claimed. Booking the claimed figure would put
 * 15,750 of stock the warehouse does not hold onto the balance sheet and create a
 * payable the company would then be free to settle - which is exactly the error
 * the pharmacy side already prevents on the payment path, and accounting must not
 * reintroduce.
 *
 * The disputed remainder is not a liability and is not booked. If it later
 * becomes one, the credit note path handles it.
 */
export async function postSupplierInvoiceAccounting(
  auth: AuthContext,
  supplierInvoiceId: string,
  tx?: Prisma.TransactionClient
): Promise<PostJournalResult> {
  const ctx = postingContext(tx);
  await assertCompanyAccountingReady(auth.companyId, ctx.read);

  const invoice = await loadDocument(auth, supplierInvoiceId, DocumentType.SUPPLIER_INVOICE, ctx.read);
  const branchId = invoice.branchId;

  const financials = await computeInvoiceFinancials(ctx.read, invoice);
  const payable = financials.acceptedPayable;
  if (payable.lessThanOrEqualTo(0)) {
    throw conflict(
      'Supplier invoice ' +
        invoice.documentNumber +
        ' has no accepted payable value, so there is nothing to book'
    );
  }

  // The payable is the accepted portion of the invoice, so the goods and tax
  // behind it are the same proportion. Splitting on the stored totals keeps
  // inventory and input tax consistent with the payable rather than with the
  // supplier's claim.
  const { goods, tax } = splitAcceptedValue(invoice, payable);

  const [inventory, inputTax, vendor] = await Promise.all([
    resolveAccountingAccount(auth.companyId, branchId, AccountMappingType.INVENTORY, ctx.read),
    resolveTaxAccount(auth.companyId, branchId, AccountMappingType.INPUT_TAX, ctx.read),
    resolveAccountingAccount(auth.companyId, branchId, AccountMappingType.VENDOR, ctx.read),
  ]);

  const lines: JournalLineInput[] = [
    {
      ledgerId: inventory.ledgerId,
      debit: goods,
      branchId,
      description: 'Goods accepted on ' + invoice.documentNumber,
      reference: invoice.documentNumber,
    },
  ];
  if (tax.greaterThan(0)) {
    lines.push({
      ledgerId: inputTax.ledgerId,
      debit: tax,
      branchId,
      description: 'Input tax on ' + invoice.documentNumber,
      reference: invoice.documentNumber,
    });
  }
  lines.push({
    ledgerId: vendor.ledgerId,
    credit: payable,
    branchId,
    // The control account carries the supplier, which is the entire accounts
    // payable subledger: 2301 stays one account and the per-supplier position is
    // a filter over its own lines.
    supplierId: invoice.supplierId,
    description:
      'Payable to ' + (invoice.supplier?.name ?? 'supplier') + ' on ' + invoice.documentNumber,
    reference: invoice.supplierRef ?? invoice.documentNumber,
  });

  return ctx.write(async (tx) => {
    const result = await postJournal(
      auth,
      {
        companyId: auth.companyId,
        branchId,
        documentDate: invoice.documentDate,
        event: AccountingEvent.SUPPLIER_INVOICE,
        sourceEventKey: accountingEventKey(AccountingEvent.SUPPLIER_INVOICE, invoice.id),
        sourceType: JournalSourceType.DOCUMENT,
        sourceDocumentId: invoice.id,
        sourceDocumentType: DocumentType.SUPPLIER_INVOICE,
        sourceReference: invoice.documentNumber,
        description:
          'Supplier invoice ' +
          invoice.documentNumber +
          ' - accepted value payable to ' +
          (invoice.supplier?.name ?? 'supplier'),
        lines,
      },
      tx
    );

    await logAccountingPosted(tx, auth, invoice.id, result, {
      goods: goods.toFixed(2),
      tax: tax.toFixed(2),
      payable: payable.toFixed(2),
      invoiceTotal: invoice.totalAmount.toFixed(2),
      disputedNotBooked: financials.disputedAmount.toFixed(2),
    });
    await markDocumentAccounting(
      tx,
      invoice.id,
      AccountingStatus.POSTED,
      'Journal ' + result.journalNumber + ' booked ' + payable.toFixed(2) + ' payable'
    );

    return result;
  });
}

/**
 * Splits an accepted payable into its goods and tax halves.
 *
 * Taken from the accepted quantity on each line where the invoice records one, so
 * the split reflects what was actually received rather than a proportion applied
 * to the whole. Falls back to pro-rating on the invoice's own tax ratio when no
 * accepted quantity is recorded, and the goods figure is always derived by
 * subtraction so the two halves add back to the payable exactly - pro-rating both
 * independently can leave a rounding paisa that unbalances the journal.
 */
function splitAcceptedValue(
  invoice: {
    subtotal: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    lineItems: {
      quantity: Prisma.Decimal;
      acceptedQuantity: Prisma.Decimal | null;
      unitPrice: Prisma.Decimal;
      taxRate: Prisma.Decimal;
    }[];
  },
  payable: Prisma.Decimal
): { goods: Prisma.Decimal; tax: Prisma.Decimal } {
  const hasAccepted = invoice.lineItems.some((l) => l.acceptedQuantity !== null);

  if (hasAccepted) {
    const goodsFromLines = money(
      sum(
        invoice.lineItems.map((line) => {
          const quantity = line.acceptedQuantity ?? line.quantity;
          return money(quantity.times(line.unitPrice));
        })
      )
    );
    const tax = money(payable.minus(goodsFromLines));
    if (!tax.isNegative() && goodsFromLines.lessThanOrEqualTo(payable)) {
      return { goods: goodsFromLines, tax };
    }
  }

  if (invoice.totalAmount.isZero()) {
    return { goods: payable, tax: ZERO };
  }
  const taxShare = money(payable.times(invoice.taxAmount).dividedBy(invoice.totalAmount));
  return { goods: money(payable.minus(taxShare)), tax: taxShare };
}

/* -------------------------------------------------- supplier payment (P10) ---- */

/**
 * What a payment has already put through the books.
 *
 * Reversals are not netted off. A reversed settlement is a deliberate correction
 * somebody raised, and treating it as unbooked would have the next auto-post
 * quietly undo it.
 */
async function bookedForPayment(db: Database, paymentId: string): Promise<Prisma.Decimal> {
  const booked = await db.journalEntry.aggregate({
    where: {
      sourcePaymentId: paymentId,
      event: AccountingEvent.SUPPLIER_PAYMENT,
      status: { in: [JournalStatus.POSTED, JournalStatus.REVERSED] },
    },
    _sum: { totalDebit: true },
  });
  return money(booked._sum.totalDebit ?? ZERO);
}

/**
 * Settles supplier liability against the account the money actually left.
 *
 * Posted for the value allocated to supplier invoices, never for the payment's
 * face value: an unallocated payment is money out of the bank against nothing in
 * particular, and booking it as a reduction in payables would understate what is
 * still owed. A payment of 40,000 allocated 36,750 against INV-0001 settles
 * 36,750 of liability and leaves 3,250 as an unallocated advance, which is what
 * the allocation model already says and what the books have to agree with.
 *
 * Allocations are re-validated before anything is booked. The allocation path
 * enforces all of this when the row is written, but accounting is what turns an
 * allocation into a movement in the books: an invoice belonging to a different
 * supplier, or to another company, would otherwise settle a liability that was
 * never owed to the party being paid.
 *
 * A payment allocated again after it was booked is topped up rather than
 * re-posted. Posted accounting is history and the first journal cannot be edited
 * to cover the increment, so the difference is booked as its own entry, keyed on
 * the allocation that caused it. Replaying the same state books nothing: what is
 * already through the books is subtracted first, and a difference of nil returns
 * the existing entry.
 */
export async function postSupplierPaymentAccounting(
  auth: AuthContext,
  paymentId: string,
  tx?: Prisma.TransactionClient
): Promise<PostJournalResult> {
  const ctx = postingContext(tx);
  await assertCompanyAccountingReady(auth.companyId, ctx.read);

  const payment = await ctx.read.payment.findUnique({
    where: { id: paymentId },
    include: {
      supplier: true,
      allocations: {
        orderBy: { createdAt: 'asc' },
        include: {
          document: {
            select: {
              id: true,
              companyId: true,
              supplierId: true,
              documentNumber: true,
              documentType: true,
              status: true,
            },
          },
        },
      },
    },
  });
  if (!payment || payment.companyId !== auth.companyId) {
    throw notFound('Payment not found');
  }
  if (payment.branchId) {
    await assertBranchAccess(auth, payment.branchId, ctx.read);
  }
  if (!payment.supplierId) {
    throw conflict(
      'Payment ' +
        payment.paymentNumber +
        ' has no supplier. Patient receipts are booked by the dispensing sale, not here.'
    );
  }
  if (payment.supplier && payment.supplier.companyId !== auth.companyId) {
    throw forbidden('Payment supplier belongs to another company');
  }

  const supplierAllocations = payment.allocations.filter(
    (a) => a.document.documentType === DocumentType.SUPPLIER_INVOICE
  );

  for (const allocation of supplierAllocations) {
    if (allocation.document.companyId !== auth.companyId) {
      throw forbidden(
        'Payment ' +
          payment.paymentNumber +
          ' is allocated to ' +
          allocation.document.documentNumber +
          ', which belongs to another company'
      );
    }
    if (allocation.document.supplierId !== payment.supplierId) {
      throw conflict(
        'Payment ' +
          payment.paymentNumber +
          ' is allocated to ' +
          allocation.document.documentNumber +
          ', which is owed to a different supplier'
      );
    }
    if (allocation.allocatedAmount.lessThanOrEqualTo(0)) {
      throw conflict(
        'Allocation on ' + allocation.document.documentNumber + ' carries no value to settle'
      );
    }
  }

  const settled = money(sum(supplierAllocations.map((a) => a.allocatedAmount)));
  if (settled.lessThanOrEqualTo(0)) {
    throw conflict(
      'Payment ' +
        payment.paymentNumber +
        ' is not allocated to any supplier invoice, so there is no liability to settle'
    );
  }
  // The books can never show more settled than the payment was worth, whatever
  // the allocations happen to add up to.
  if (settled.greaterThan(payment.amount)) {
    throw conflict(
      'Payment ' +
        payment.paymentNumber +
        ' is allocated ' +
        settled.toFixed(2) +
        ' against a payment of ' +
        payment.amount.toFixed(2)
    );
  }

  const alreadyBooked = await bookedForPayment(ctx.read, payment.id);
  const toBook = money(settled.minus(alreadyBooked));

  if (toBook.lessThanOrEqualTo(0)) {
    // The settled position and the books already agree, so the entry that says so
    // is returned rather than a second one raised.
    const existing = await ctx.read.journalEntry.findUnique({
      where: {
        companyId_sourceEventKey: {
          companyId: auth.companyId,
          sourceEventKey: accountingEventKey(AccountingEvent.SUPPLIER_PAYMENT, payment.id),
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
  }

  const isTopUp = alreadyBooked.greaterThan(0);
  const amount = isTopUp ? toBook : settled;
  const latestAllocation = supplierAllocations[supplierAllocations.length - 1];
  const sourceEventKey = isTopUp
    ? paymentAllocationEventKey(payment.id, latestAllocation.id)
    : accountingEventKey(AccountingEvent.SUPPLIER_PAYMENT, payment.id);

  const fundingRole =
    payment.method === 'CASH' ? AccountMappingType.CASH : AccountMappingType.BANK;
  const [vendor, funding] = await Promise.all([
    resolveAccountingAccount(auth.companyId, payment.branchId, AccountMappingType.VENDOR, ctx.read),
    resolveAccountingAccount(auth.companyId, payment.branchId, fundingRole, ctx.read),
  ]);

  const invoiceNumbers = supplierAllocations.map((a) => a.document.documentNumber).join(', ');

  return ctx.write(async (writeTx) => {
    const result = await postJournal(
      auth,
      {
        companyId: auth.companyId,
        branchId: payment.branchId,
        documentDate: payment.paymentDate,
        event: AccountingEvent.SUPPLIER_PAYMENT,
        sourceEventKey,
        sourceType: JournalSourceType.PAYMENT,
        sourcePaymentId: payment.id,
        sourceDocumentType: 'PAYMENT',
        sourceReference: payment.paymentNumber,
        description:
          (isTopUp ? 'Further allocation of payment ' : 'Payment ') +
          payment.paymentNumber +
          ' to ' +
          (payment.supplier?.name ?? 'supplier') +
          ' settling ' +
          invoiceNumbers,
        lines: [
          {
            ledgerId: vendor.ledgerId,
            debit: amount,
            branchId: payment.branchId,
            // The payable side names the supplier: this is the line the accounts
            // payable subledger is built from.
            supplierId: payment.supplierId,
            description: 'Settlement of ' + invoiceNumbers,
            reference: payment.paymentNumber,
          },
          {
            ledgerId: funding.ledgerId,
            credit: amount,
            branchId: payment.branchId,
            description: payment.method + ' payment ' + payment.paymentNumber,
            reference: payment.reference ?? payment.paymentNumber,
          },
        ],
      },
      writeTx
    );

    // Logged against each invoice the payment settled, so the trail is reachable
    // from the document as well as from the payment.
    for (const allocation of supplierAllocations) {
      await logAccountingPosted(writeTx, auth, allocation.documentId, result, {
        payment: payment.paymentNumber,
        settled: allocation.allocatedAmount.toFixed(2),
        method: payment.method,
      });
    }

    await markPaymentAccounting(
      writeTx,
      payment.id,
      AccountingStatus.POSTED,
      'Journal ' +
        result.journalNumber +
        ' settled ' +
        settled.toFixed(2) +
        ' of supplier liability'
    );

    return result;
  });
}

/* ------------------------------------------------------- credit note (P15) ---- */

/**
 * Reverses the part of a supplier liability that was never owed.
 *
 * The credit note in this workflow clears disputed invoice value - stock damaged
 * in transit or short delivered - and the invoice journal never booked that value
 * in the first place, because it books the accepted payable only. Posting the full
 * credit as a reduction of payables would therefore take the liability below what
 * is actually owed.
 *
 * So the journal is raised for the portion of the credit that was booked: the
 * credit less any part that only cleared an unbooked dispute. In the standard
 * flow that is nil, and the credit note is recorded as a memo entry against the
 * invoice rather than a movement - which is the honest answer, not a missing one.
 */
export async function postCreditNoteAccounting(
  auth: AuthContext,
  creditNoteId: string,
  tx?: Prisma.TransactionClient
): Promise<PostJournalResult | { skipped: true; reason: string }> {
  const ctx = postingContext(tx);
  await assertCompanyAccountingReady(auth.companyId, ctx.read);

  const creditNote = await loadDocument(auth, creditNoteId, DocumentType.CREDIT_NOTE, ctx.read);
  const branchId = creditNote.branchId;

  const link = await ctx.read.documentLink.findFirst({
    where: { sourceDocumentId: creditNote.id, linkType: DocumentLinkType.CREDIT_FOR },
    select: { targetDocumentId: true },
  });
  if (!link) {
    throw conflict(
      'Credit note ' +
        creditNote.documentNumber +
        ' is not linked to a supplier invoice, so there is no liability to reduce'
    );
  }

  const invoice = await ctx.read.document.findUniqueOrThrow({
    where: { id: link.targetDocumentId },
    include: { lineItems: true, supplier: true },
  });

  // What the invoice journal actually booked. Anything the credit clears beyond
  // that was never a liability in the books.
  const invoiceJournal = await ctx.read.journalEntry.findUnique({
    where: {
      companyId_sourceEventKey: {
        companyId: auth.companyId,
        sourceEventKey: accountingEventKey(AccountingEvent.SUPPLIER_INVOICE, invoice.id),
      },
    },
    select: { id: true, journalNumber: true, totalCredit: true, status: true },
  });

  const bookedPayable = invoiceJournal ? invoiceJournal.totalCredit : ZERO;
  const creditTotal = creditNote.totalAmount;

  // The part of the credit that lands on booked liability: the credit less the
  // portion of the invoice that was never booked in the first place.
  const invoiceTotal = invoice.totalAmount;
  const unbookedDispute = money(invoiceTotal.minus(bookedPayable));
  const bookedPortion = money(creditTotal.minus(unbookedDispute));

  if (bookedPortion.lessThanOrEqualTo(0)) {
    const reason =
      'Credit note ' +
      creditNote.documentNumber +
      ' clears ' +
      creditTotal.toFixed(2) +
      ' of disputed value that was never booked as a liability (the invoice journal booked the accepted payable of ' +
      bookedPayable.toFixed(2) +
      ' against an invoice total of ' +
      invoiceTotal.toFixed(2) +
      '), so no journal is raised.';

    // A memo against the document rather than a movement in the books. The
    // document is marked SKIPPED rather than left looking unposted: "no journal"
    // here is an answer, not an omission, and a reviewer who cannot tell the two
    // apart will go looking for a missing entry that was never owed.
    await ctx.write(async (writeTx) => {
      await logDocumentAction(writeTx, {
        companyId: auth.companyId,
        documentId: creditNote.id,
        userId: auth.userId,
        action: AccountingAuditAction.ACCOUNTING_POSTED,
        reason:
          'No journal raised: the credit clears invoice value that was never booked as a liability',
        newData: {
          creditTotal: creditTotal.toFixed(2),
          invoiceTotal: invoiceTotal.toFixed(2),
          bookedPayable: bookedPayable.toFixed(2),
          invoiceJournal: invoiceJournal?.journalNumber ?? 'none',
        },
      });
      await markDocumentAccounting(writeTx, creditNote.id, AccountingStatus.SKIPPED, reason);
    });

    return { skipped: true as const, reason };
  }

  const { goods, tax } = splitAcceptedValue(
    {
      subtotal: creditNote.subtotal,
      taxAmount: creditNote.taxAmount,
      totalAmount: creditNote.totalAmount,
      lineItems: [],
    },
    bookedPortion
  );

  const [inventory, inputTax, vendor] = await Promise.all([
    resolveAccountingAccount(auth.companyId, branchId, AccountMappingType.INVENTORY, ctx.read),
    resolveTaxAccount(auth.companyId, branchId, AccountMappingType.INPUT_TAX, ctx.read),
    resolveAccountingAccount(auth.companyId, branchId, AccountMappingType.VENDOR, ctx.read),
  ]);

  const lines: JournalLineInput[] = [
    {
      ledgerId: vendor.ledgerId,
      debit: bookedPortion,
      branchId,
      supplierId: creditNote.supplierId,
      description:
        'Credit note ' + creditNote.documentNumber + ' against ' + invoice.documentNumber,
      reference: creditNote.supplierRef ?? creditNote.documentNumber,
    },
    {
      ledgerId: inventory.ledgerId,
      credit: goods,
      branchId,
      description: 'Goods credited on ' + creditNote.documentNumber,
      reference: creditNote.documentNumber,
    },
  ];
  if (tax.greaterThan(0)) {
    lines.push({
      ledgerId: inputTax.ledgerId,
      credit: tax,
      branchId,
      description: 'Input tax reversed on ' + creditNote.documentNumber,
      reference: creditNote.documentNumber,
    });
  }

  return ctx.write(async (writeTx) => {
    const result = await postJournal(
      auth,
      {
        companyId: auth.companyId,
        branchId,
        documentDate: creditNote.documentDate,
        event: AccountingEvent.CREDIT_NOTE,
        sourceEventKey: accountingEventKey(AccountingEvent.CREDIT_NOTE, creditNote.id),
        sourceType: JournalSourceType.DOCUMENT,
        sourceDocumentId: creditNote.id,
        sourceDocumentType: DocumentType.CREDIT_NOTE,
        sourceReference: creditNote.documentNumber,
        description:
          'Credit note ' +
          creditNote.documentNumber +
          ' reducing the payable raised by ' +
          invoice.documentNumber,
        lines,
      },
      writeTx
    );

    await logAccountingPosted(writeTx, auth, creditNote.id, result, {
      creditTotal: creditTotal.toFixed(2),
      bookedPortion: bookedPortion.toFixed(2),
      against: invoice.documentNumber,
    });
    await markDocumentAccounting(
      writeTx,
      creditNote.id,
      AccountingStatus.POSTED,
      'Journal ' +
        result.journalNumber +
        ' reduced the payable by ' +
        bookedPortion.toFixed(2)
    );

    return result;
  });
}

/* ----------------------------------------------------------- sales (P11) ---- */

/**
 * Books a dispensing sale: what the patient paid, the revenue earned and the tax
 * collected on the company's behalf.
 *
 * Tax is a liability, not income - it is collected for the government, and
 * folding it into revenue would overstate the top line and understate what is
 * owed. The funding account follows how the patient actually paid rather than a
 * fixed assumption of cash.
 */
export async function postSalesAccounting(
  auth: AuthContext,
  dispensingId: string,
  tx?: Prisma.TransactionClient
): Promise<PostJournalResult> {
  const ctx = postingContext(tx);
  await assertCompanyAccountingReady(auth.companyId, ctx.read);

  const sale = await loadDocument(auth, dispensingId, DocumentType.DISPENSING, ctx.read);
  const branchId = sale.branchId;

  const total = sale.totalAmount;
  if (total.lessThanOrEqualTo(0)) {
    throw conflict('Dispensing ' + sale.documentNumber + ' has no value to book');
  }

  // How the patient paid decides which asset increased. Unpaid value is a
  // receivable rather than cash the branch does not have.
  const allocation = await ctx.read.paymentAllocation.findFirst({
    where: { documentId: sale.id },
    include: { payment: { select: { method: true, paymentNumber: true } } },
  });

  const fundingRole = !allocation
    ? AccountMappingType.CUSTOMER
    : allocation.payment.method === 'CASH'
      ? AccountMappingType.CASH
      : AccountMappingType.BANK;

  const [funding, salesAccount, outputTax] = await Promise.all([
    resolveAccountingAccount(auth.companyId, branchId, fundingRole, ctx.read),
    resolveAccountingAccount(auth.companyId, branchId, AccountMappingType.SALES, ctx.read),
    resolveTaxAccount(auth.companyId, branchId, AccountMappingType.OUTPUT_TAX, ctx.read),
  ]);

  const lines: JournalLineInput[] = [
    {
      ledgerId: funding.ledgerId,
      debit: total,
      branchId,
      description:
        'Patient settlement on ' +
        sale.documentNumber +
        (allocation ? ' via ' + allocation.payment.paymentNumber : ' (unsettled)'),
      reference: sale.patientRef ?? sale.documentNumber,
    },
    {
      ledgerId: salesAccount.ledgerId,
      credit: sale.subtotal,
      branchId,
      description: 'Revenue on ' + sale.documentNumber,
      reference: sale.prescriptionRef ?? sale.documentNumber,
    },
  ];
  if (sale.taxAmount.greaterThan(0)) {
    lines.push({
      ledgerId: outputTax.ledgerId,
      credit: sale.taxAmount,
      branchId,
      description: 'Output tax on ' + sale.documentNumber,
      reference: sale.documentNumber,
    });
  }

  return ctx.write(async (writeTx) => {
    const result = await postJournal(
      auth,
      {
        companyId: auth.companyId,
        branchId,
        documentDate: sale.documentDate,
        event: AccountingEvent.SALES,
        sourceEventKey: accountingEventKey(AccountingEvent.SALES, sale.id),
        sourceType: JournalSourceType.DOCUMENT,
        sourceDocumentId: sale.id,
        sourceDocumentType: DocumentType.DISPENSING,
        sourceReference: sale.documentNumber,
        description: 'Dispensing sale ' + sale.documentNumber,
        lines,
      },
      writeTx
    );

    await logAccountingPosted(writeTx, auth, sale.id, result, {
      revenue: sale.subtotal.toFixed(2),
      tax: sale.taxAmount.toFixed(2),
      total: total.toFixed(2),
      settledTo: funding.ledgerCode,
    });

    return result;
  });
}

/* ------------------------------------------------------------ COGS (P12) ---- */

/**
 * Moves the cost of dispensed stock out of inventory and into cost of sales.
 *
 * The cost comes from the stock ledger movements the dispensing itself wrote -
 * `InventoryTransaction.totalCost`, at the batch cost the inventory service
 * recorded. It is never derived from the selling price, and accounting never
 * recomputes it: inventory valuation is the inventory module's job, and a second
 * opinion here would drift from the stock ledger the moment either changed.
 *
 * Accounting consumes the authoritative cost; it does not have one of its own.
 */
export async function postCOGSAccounting(
  auth: AuthContext,
  dispensingId: string,
  tx?: Prisma.TransactionClient
): Promise<PostJournalResult> {
  const ctx = postingContext(tx);
  await assertCompanyAccountingReady(auth.companyId, ctx.read);

  const sale = await loadDocument(auth, dispensingId, DocumentType.DISPENSING, ctx.read);
  const branchId = sale.branchId;

  const movements = await ctx.read.inventoryTransaction.findMany({
    where: {
      documentId: sale.id,
      companyId: auth.companyId,
      transactionType: InventoryTransactionType.DISPENSING,
    },
    select: { quantity: true, unitCost: true, totalCost: true },
  });
  if (movements.length === 0) {
    throw conflict(
      'Dispensing ' +
        sale.documentNumber +
        ' has no stock movements, so there is no inventory cost to relieve'
    );
  }

  // Issues are stored as negative quantities, so their cost is negative too.
  // The absolute value is what leaves inventory.
  const cost = money(sum(movements.map((m) => m.totalCost)).absoluteValue());
  if (cost.lessThanOrEqualTo(0)) {
    throw conflict(
      'Dispensing ' + sale.documentNumber + ' relieved stock at zero cost; nothing to book'
    );
  }

  const [cogs, inventory] = await Promise.all([
    resolveAccountingAccount(auth.companyId, branchId, AccountMappingType.DIRECT_COST, ctx.read),
    resolveAccountingAccount(auth.companyId, branchId, AccountMappingType.INVENTORY, ctx.read),
  ]);

  return ctx.write(async (writeTx) => {
    const result = await postJournal(
      auth,
      {
        companyId: auth.companyId,
        branchId,
        documentDate: sale.documentDate,
        event: AccountingEvent.COGS,
        sourceEventKey: accountingEventKey(AccountingEvent.COGS, sale.id),
        sourceType: JournalSourceType.DOCUMENT,
        sourceDocumentId: sale.id,
        sourceDocumentType: DocumentType.DISPENSING,
        sourceReference: sale.documentNumber,
        description: 'Cost of goods dispensed on ' + sale.documentNumber,
        lines: [
          {
            ledgerId: cogs.ledgerId,
            debit: cost,
            branchId,
            description: 'Cost of stock issued on ' + sale.documentNumber,
            reference: sale.documentNumber,
          },
          {
            ledgerId: inventory.ledgerId,
            credit: cost,
            branchId,
            description: 'Stock relieved by ' + sale.documentNumber,
            reference: sale.documentNumber,
          },
        ],
      },
      writeTx
    );

    await logAccountingPosted(writeTx, auth, sale.id, result, {
      cost: cost.toFixed(2),
      movements: String(movements.length),
      source: 'InventoryTransaction.totalCost',
    });

    return result;
  });
}

/* ------------------------------------------------------- document dispatch ---- */

export interface DocumentAccountingOutcome {
  documentNumber: string;
  documentType: DocumentType;
  journals: {
    event: AccountingEvent;
    journalEntryId: string;
    journalNumber: string;
    alreadyPosted: boolean;
  }[];
  skipped: { event: string; reason: string }[];
}

/**
 * Raises every journal one business document calls for.
 *
 * Dispensing produces two: the sale and the cost of the goods sold. They are
 * separate entries rather than one combined posting because they answer different
 * questions - one is revenue, the other is margin - and because reversing a
 * mis-stated cost should not disturb a correctly stated sale.
 *
 * Passing a transaction client books the document inside the caller's
 * transaction, which is how the business services post: the journal commits with
 * the invoice, or neither does.
 */
export async function postDocumentAccounting(
  auth: AuthContext,
  documentId: string,
  tx?: Prisma.TransactionClient
): Promise<DocumentAccountingOutcome> {
  const ctx = postingContext(tx);

  const document = await ctx.read.document.findUnique({
    where: { id: documentId },
    select: { id: true, companyId: true, documentNumber: true, documentType: true },
  });
  if (!document || document.companyId !== auth.companyId) {
    throw notFound('Document not found');
  }

  const journals: DocumentAccountingOutcome['journals'] = [];
  const skipped: DocumentAccountingOutcome['skipped'] = [];

  switch (document.documentType) {
    case DocumentType.SUPPLIER_INVOICE: {
      const result = await postSupplierInvoiceAccounting(auth, documentId, tx);
      journals.push({ event: AccountingEvent.SUPPLIER_INVOICE, ...result });
      break;
    }
    case DocumentType.CREDIT_NOTE: {
      const result = await postCreditNoteAccounting(auth, documentId, tx);
      if ('skipped' in result) {
        skipped.push({ event: AccountingEvent.CREDIT_NOTE, reason: result.reason });
      } else {
        journals.push({ event: AccountingEvent.CREDIT_NOTE, ...result });
      }
      break;
    }
    case DocumentType.DISPENSING: {
      // Two entries, and both or neither: a sale whose cost never reached the
      // books reports the whole selling price as margin.
      const sale = await postSalesAccounting(auth, documentId, tx);
      journals.push({ event: AccountingEvent.SALES, ...sale });
      const cogs = await postCOGSAccounting(auth, documentId, tx);
      journals.push({ event: AccountingEvent.COGS, ...cogs });
      // Marked here rather than inside either posting, because a dispensing is
      // only booked once both have been: a document reading POSTED off the back
      // of the sale alone would be claiming a cost that had not been relieved.
      await ctx.write((writeTx) =>
        markDocumentAccounting(
          writeTx,
          documentId,
          AccountingStatus.POSTED,
          'Sale booked by ' + sale.journalNumber + ' and cost of sales by ' + cogs.journalNumber
        )
      );
      break;
    }
    case DocumentType.STOCK_TRANSFER:
      skipped.push({
        event: 'STOCK_TRANSFER',
        reason:
          'An internal stock transfer moves the same stock, at the same cost, between two branches of one company. ' +
          'No revenue is earned and no expense is incurred, so no journal is raised. The branch-level movement is in the stock ledger.',
      });
      break;
    case DocumentType.GOODS_RECEIPT:
      skipped.push({
        event: 'GOODS_RECEIPT',
        reason:
          'The payable and the inventory debit are recognised at supplier invoice stage under this deployment policy. ' +
          'Booking the receipt as well would double the asset.',
      });
      break;
    default:
      skipped.push({
        event: document.documentType,
        reason: 'This document type does not produce accounting entries.',
      });
  }

  // A document type that never books anything says so on its own record, so the
  // Accounting tab reads "not required" rather than leaving a reviewer to wonder
  // whether an entry went missing. The posting paths above have already written
  // POSTED or SKIPPED for the types that do book.
  if (journals.length === 0 && skipped.length > 0 && document.documentType !== DocumentType.CREDIT_NOTE) {
    await ctx.write((writeTx) =>
      markDocumentAccounting(
        writeTx,
        document.id,
        AccountingStatus.NOT_REQUIRED,
        skipped[0].reason
      )
    );
  }

  return {
    documentNumber: document.documentNumber,
    documentType: document.documentType,
    journals,
    skipped,
  };
}

export { splitAcceptedValue };
