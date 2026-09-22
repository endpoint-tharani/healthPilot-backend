import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountingEvent,
  AccountMappingType,
  BranchScopeType,
  BranchType,
  DocumentStatus,
  DocumentType,
  InventoryTransactionType,
  JournalStatus,
  PaymentMethod,
  Prisma,
  StockStatus,
  UserRole,
} from '@prisma/client';
import { prisma, disconnectDatabase } from '../../database/prisma';
import { AuthContext } from '../../context/authContext';
import { permissionsForRole } from '../../constants/permissions';
import { accountingEventKey } from '../../constants/accounting';
import {
  countChart,
  initializeCompanyAccounting,
} from '../../services/accounting/chartOfAccounts.service';
import { resolveAccountingAccount } from '../../services/accounting/accountMapping.service';
import {
  deleteDraftJournal,
  postJournal,
  reverseJournalEntry,
} from '../../services/accounting/journal.service';
import {
  postCOGSAccounting,
  postDocumentAccounting,
  postSalesAccounting,
  postSupplierInvoiceAccounting,
  postSupplierPaymentAccounting,
} from '../../services/accounting/accounting.service';
import { getGeneralLedger } from '../../services/accounting/generalLedger.service';
import {
  getBalanceSheet,
  getProfitAndLoss,
  getTrialBalance,
} from '../../services/accounting/reports.service';

/**
 * The accounting module against a real database.
 *
 * Two throwaway tenants are created per run under a unique code, exercised, and
 * removed afterwards. Nothing here touches the demo tenants the seed owns, so
 * running the suite never disturbs a reviewer's data - and because both tenants
 * are real, the isolation tests prove something rather than assuming it.
 *
 * The documents are written directly rather than raised through the pharmacy
 * services. That is deliberate: these tests are about the accounting layer, and
 * the end-to-end path from a real stock requisition through to a posted journal
 * is covered by `npm run verify:accounting` against the seeded scenario.
 */

/**
 * The document-driven postings all carry scenario dates on or before 9 September;
 * the manual entries the posting tests raise are dated from the 10th onwards.
 * Reports asserted on exact figures use this window, so they measure the supplier
 * invoice, payment, sale and cost of sales rather than those plus whatever a
 * neighbouring test happened to post to the same account.
 */
const SCENARIO = { toDate: new Date('2026-09-09T23:59:59.999Z') };

const RUN = Date.now().toString(36);
const COMPANY_A = 'TEST-ACC-A-' + RUN;
const COMPANY_B = 'TEST-ACC-B-' + RUN;

interface Tenant {
  companyId: string;
  branchId: string;
  otherBranchId: string;
  userId: string;
  auth: AuthContext;
  /** A user confined to otherBranchId, for the branch-scope tests. */
  branchAuth: AuthContext;
  supplierId: string;
  productId: string;
  batchId: string;
}

let a: Tenant;
let b: Tenant;

async function createTenant(code: string): Promise<Tenant> {
  const company = await prisma.company.create({ data: { code, name: code } });

  const branch = await prisma.branch.create({
    data: {
      companyId: company.id,
      code: 'MAIN',
      name: 'Main',
      type: BranchType.CENTRAL_WAREHOUSE,
    },
  });
  const otherBranch = await prisma.branch.create({
    data: { companyId: company.id, code: 'SECOND', name: 'Second', type: BranchType.BRANCH },
  });

  const user = await prisma.user.create({
    data: {
      companyId: company.id,
      email: 'admin@' + code.toLowerCase() + '.test',
      name: 'Test Accountant',
      role: UserRole.COMPANY_ADMIN,
      passwordHash: 'not-a-real-hash',
      branchScope: BranchScopeType.ALL_BRANCHES,
    },
  });
  const branchUser = await prisma.user.create({
    data: {
      companyId: company.id,
      email: 'branch@' + code.toLowerCase() + '.test',
      name: 'Test Branch User',
      role: UserRole.COMPANY_ADMIN,
      passwordHash: 'not-a-real-hash',
      branchScope: BranchScopeType.SPECIFIC_BRANCHES,
      branchId: otherBranch.id,
    },
  });

  const supplier = await prisma.supplier.create({
    data: { companyId: company.id, code: 'SUP', name: 'Test Supplier' },
  });
  const product = await prisma.product.create({
    data: {
      companyId: company.id,
      code: 'PRD',
      name: 'Test Product',
      unit: 'Vial',
      purchasePrice: '500.00',
      sellingPrice: '650.00',
      taxRate: '5.00',
    },
  });
  const batch = await prisma.batch.create({
    data: {
      companyId: company.id,
      productId: product.id,
      batchNumber: 'B1',
      expiryDate: new Date('2030-01-01'),
    },
  });

  const auth: AuthContext = {
    userId: user.id,
    companyId: company.id,
    role: UserRole.COMPANY_ADMIN,
    scopeType: BranchScopeType.ALL_BRANCHES,
    hasAllBranches: true,
    allowedBranchIds: [],
    hasCentralWarehouseAccess: true,
    permissions: permissionsForRole(UserRole.COMPANY_ADMIN),
  };

  const branchAuth: AuthContext = {
    ...auth,
    userId: branchUser.id,
    scopeType: BranchScopeType.SPECIFIC_BRANCHES,
    hasAllBranches: false,
    allowedBranchIds: [otherBranch.id],
    hasCentralWarehouseAccess: false,
  };

  await initializeCompanyAccounting(company.id);

  return {
    companyId: company.id,
    branchId: branch.id,
    otherBranchId: otherBranch.id,
    userId: user.id,
    auth,
    branchAuth,
    supplierId: supplier.id,
    productId: product.id,
    batchId: batch.id,
  };
}

async function dropTenant(code: string) {
  const company = await prisma.company.findUnique({ where: { code }, select: { id: true } });
  if (!company) {
    return;
  }
  const companyId = company.id;

  // Foreign-key order: everything that points at a row goes before the row.
  await prisma.journalLine.deleteMany({ where: { journalEntry: { companyId } } });
  await prisma.journalEntry.deleteMany({ where: { companyId } });
  await prisma.accountMapping.deleteMany({ where: { companyId } });
  await prisma.ledger.deleteMany({ where: { companyId } });
  await prisma.accountSubGroup.deleteMany({ where: { companyId } });
  await prisma.accountGroup.deleteMany({ where: { companyId } });
  await prisma.accountHead.deleteMany({ where: { companyId } });
  await prisma.accountNatureType.deleteMany({ where: { companyId } });
  await prisma.accountNature.deleteMany({ where: { companyId } });
  await prisma.documentLog.deleteMany({ where: { companyId } });
  await prisma.notification.deleteMany({ where: { companyId } });
  await prisma.paymentAllocation.deleteMany({ where: { payment: { companyId } } });
  await prisma.inventoryTransaction.deleteMany({ where: { companyId } });
  await prisma.documentLink.deleteMany({ where: { companyId } });
  await prisma.documentLineItem.deleteMany({ where: { document: { companyId } } });
  await prisma.payment.deleteMany({ where: { companyId } });
  await prisma.document.deleteMany({ where: { companyId } });
  await prisma.refreshToken.deleteMany({ where: { user: { companyId } } });
  await prisma.userBranchAccess.deleteMany({ where: { branch: { companyId } } });
  await prisma.user.deleteMany({ where: { companyId } });
  await prisma.batch.deleteMany({ where: { companyId } });
  await prisma.product.deleteMany({ where: { companyId } });
  await prisma.supplier.deleteMany({ where: { companyId } });
  await prisma.branch.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
}

/** A supplier invoice billing 100 but with only 70 accepted, as the scenario has. */
async function createSupplierInvoiceRow(tenant: Tenant, documentNumber: string) {
  return prisma.document.create({
    data: {
      companyId: tenant.companyId,
      branchId: tenant.branchId,
      supplierId: tenant.supplierId,
      documentNumber,
      documentType: DocumentType.SUPPLIER_INVOICE,
      status: DocumentStatus.DISCREPANT,
      documentDate: new Date('2026-09-06'),
      subtotal: '50000.00',
      taxAmount: '2500.00',
      totalAmount: '52500.00',
      disputedAmount: '15750.00',
      balanceAmount: '52500.00',
      createdById: tenant.userId,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: tenant.productId,
            quantity: '100',
            acceptedQuantity: '70',
            unitPrice: '500.00',
            subtotal: '50000.00',
            taxRate: '5.00',
            taxAmount: '2500.00',
            total: '52500.00',
            unitOfMeasure: 'Vial',
          },
        ],
      },
    },
    include: { lineItems: true },
  });
}

async function createDispensingRow(tenant: Tenant, documentNumber: string, branchId?: string) {
  const document = await prisma.document.create({
    data: {
      companyId: tenant.companyId,
      branchId: branchId ?? tenant.branchId,
      documentNumber,
      documentType: DocumentType.DISPENSING,
      status: DocumentStatus.COMPLETED,
      documentDate: new Date('2026-09-09'),
      patientRef: 'PAT-1',
      prescriptionRef: 'RX-1',
      subtotal: '3250.00',
      taxAmount: '162.50',
      totalAmount: '3412.50',
      paidAmount: '3412.50',
      balanceAmount: '0.00',
      createdById: tenant.userId,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: tenant.productId,
            batchId: tenant.batchId,
            quantity: '5',
            unitPrice: '650.00',
            subtotal: '3250.00',
            taxRate: '5.00',
            taxAmount: '162.50',
            total: '3412.50',
            unitOfMeasure: 'Vial',
          },
        ],
      },
    },
    include: { lineItems: true },
  });

  // The stock movement the dispensing service writes: issued at the batch cost,
  // which is the only figure the COGS posting is allowed to use.
  await prisma.inventoryTransaction.create({
    data: {
      companyId: tenant.companyId,
      branchId: branchId ?? tenant.branchId,
      productId: tenant.productId,
      batchId: tenant.batchId,
      documentId: document.id,
      documentLineItemId: document.lineItems[0].id,
      transactionType: InventoryTransactionType.DISPENSING,
      quantity: '-5',
      unitCost: '500.00',
      totalCost: '-2500.00',
      stockStatus: StockStatus.USABLE,
      createdById: tenant.userId,
    },
  });

  const payment = await prisma.payment.create({
    data: {
      companyId: tenant.companyId,
      branchId: branchId ?? tenant.branchId,
      paymentNumber: 'PAY-' + documentNumber,
      amount: '3412.50',
      method: PaymentMethod.CARD,
      createdById: tenant.userId,
    },
  });
  await prisma.paymentAllocation.create({
    data: { paymentId: payment.id, documentId: document.id, allocatedAmount: '3412.50' },
  });

  return document;
}

beforeAll(async () => {
  a = await createTenant(COMPANY_A);
  b = await createTenant(COMPANY_B);
}, 180_000);

afterAll(async () => {
  await dropTenant(COMPANY_A);
  await dropTenant(COMPANY_B);
  await disconnectDatabase();
}, 180_000);

/* ------------------------------------------------ chart of accounts (P6) ---- */

describe('chart of accounts initialisation', () => {
  it('creates the full Ind AS hierarchy for a company', async () => {
    const counts = await countChart(a.companyId);
    expect(counts.natures).toBe(5);
    expect(counts.natureTypes).toBe(7);
    expect(counts.heads).toBe(36);
    expect(counts.groups).toBe(16);
    expect(counts.subGroups).toBe(8);
    expect(counts.ledgers).toBe(38);
    expect(counts.mappings).toBe(15);
  });

  it('records the template it was initialised from', async () => {
    const company = await prisma.company.findUniqueOrThrow({
      where: { id: a.companyId },
      select: { accountingTemplateKey: true, accountingTemplateVersion: true },
    });
    expect(company.accountingTemplateKey).toBe('IND_AS');
    expect(company.accountingTemplateVersion).toBe('1.1.0');
  });

  it('is idempotent: a second run creates nothing', async () => {
    const before = await countChart(a.companyId);
    const result = await initializeCompanyAccounting(a.companyId);

    expect(result.alreadyInitialized).toBe(true);
    expect(result.created).toEqual({
      natures: 0,
      natureTypes: 0,
      heads: 0,
      groups: 0,
      subGroups: 0,
      ledgers: 0,
      mappings: 0,
    });
    expect(await countChart(a.companyId)).toEqual(before);
  }, 120_000);

  it('does not undo a company renaming an unlocked account', async () => {
    // 4201 Other Income is not locked by the format, so a company may rename it.
    const ledger = await prisma.ledger.findUniqueOrThrow({
      where: { companyId_code: { companyId: a.companyId, code: '4201' } },
    });
    expect(ledger.isLocked).toBe(false);

    await prisma.ledger.update({
      where: { id: ledger.id },
      data: { name: 'Sundry receipts (renamed by the company)' },
    });
    await initializeCompanyAccounting(a.companyId);

    const after = await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } });
    expect(after.name).toBe('Sundry receipts (renamed by the company)');

    await prisma.ledger.update({ where: { id: ledger.id }, data: { name: ledger.name } });
  }, 120_000);

  it('refuses to re-base a company onto a different reporting format', async () => {
    await expect(initializeCompanyAccounting(a.companyId, 'US_GAAP')).rejects.toThrow(
      /Unknown accounting template/
    );
  });

  it('gives each company its own separate chart', async () => {
    const [ledgerA, ledgerB] = await Promise.all([
      prisma.ledger.findUniqueOrThrow({
        where: { companyId_code: { companyId: a.companyId, code: '401010001' } },
      }),
      prisma.ledger.findUniqueOrThrow({
        where: { companyId_code: { companyId: b.companyId, code: '401010001' } },
      }),
    ]);
    expect(ledgerA.id).not.toBe(ledgerB.id);
  });
});

/* ------------------------------------------------- mapping resolution (P5) ---- */

describe('account mapping resolution', () => {
  it('resolves a ledger-target role to the account the format names', async () => {
    const sales = await resolveAccountingAccount(a.companyId, null, AccountMappingType.SALES);
    expect(sales.ledgerCode).toBe('401010001');
    expect(sales.via).toBe('LEDGER');
    expect(sales.resolvedFrom).toBe('COMPANY');
  });

  it('resolves a head-target role through the head default', async () => {
    const inventory = await resolveAccountingAccount(
      a.companyId,
      null,
      AccountMappingType.INVENTORY
    );
    expect(inventory.headCode).toBe('10800');
    expect(inventory.via).toBe('HEAD');
    expect(inventory.ledgerCode).toBe('108010001');
  });

  it('prefers a branch override over the company default', async () => {
    const cash = await resolveAccountingAccount(a.companyId, null, AccountMappingType.BANK);
    const alternative = await prisma.ledger.findUniqueOrThrow({
      where: { companyId_code: { companyId: a.companyId, code: '111000001' } },
    });

    await prisma.accountMapping.create({
      data: {
        companyId: a.companyId,
        branchId: a.otherBranchId,
        scopeKey: a.otherBranchId,
        mappingType: AccountMappingType.BANK,
        target: 'LEDGER',
        ledgerId: alternative.id,
      },
    });

    const override = await resolveAccountingAccount(
      a.companyId,
      a.otherBranchId,
      AccountMappingType.BANK
    );
    expect(override.ledgerCode).toBe('111000001');
    expect(override.resolvedFrom).toBe('BRANCH');

    // The company default is untouched for every other branch.
    const stillDefault = await resolveAccountingAccount(
      a.companyId,
      a.branchId,
      AccountMappingType.BANK
    );
    expect(stillDefault.ledgerCode).toBe(cash.ledgerCode);

    await prisma.accountMapping.deleteMany({
      where: {
        companyId: a.companyId,
        scopeKey: a.otherBranchId,
        mappingType: AccountMappingType.BANK,
      },
    });
  });

  it('never resolves into another company chart', async () => {
    const fromA = await resolveAccountingAccount(a.companyId, null, AccountMappingType.SALES);
    const fromB = await resolveAccountingAccount(b.companyId, null, AccountMappingType.SALES);
    expect(fromA.ledgerCode).toBe(fromB.ledgerCode);
    expect(fromA.ledgerId).not.toBe(fromB.ledgerId);
  });

  it('refuses to post to an inactive account rather than guessing another', async () => {
    const rounding = await resolveAccountingAccount(
      a.companyId,
      null,
      AccountMappingType.ROUNDING
    );
    await prisma.ledger.update({ where: { id: rounding.ledgerId }, data: { isActive: false } });

    await expect(
      resolveAccountingAccount(a.companyId, null, AccountMappingType.ROUNDING)
    ).rejects.toThrow(/inactive/);

    await prisma.ledger.update({ where: { id: rounding.ledgerId }, data: { isActive: true } });
  });
});

/* ------------------------------------------------------- journal posting (P7) ---- */

describe('journal posting', () => {
  async function twoLedgers(tenant: Tenant) {
    const [debit, credit] = await Promise.all([
      resolveAccountingAccount(tenant.companyId, null, AccountMappingType.BANK),
      resolveAccountingAccount(tenant.companyId, null, AccountMappingType.SALES),
    ]);
    return { debit, credit };
  }

  it('writes a balanced entry and records who posted it', async () => {
    const { debit, credit } = await twoLedgers(a);
    const result = await postJournal(a.auth, {
      companyId: a.companyId,
      branchId: a.branchId,
      documentDate: new Date('2026-09-10'),
      event: AccountingEvent.MANUAL,
      sourceEventKey: 'TEST:balanced:' + RUN,
      description: 'A balanced manual entry',
      lines: [
        { ledgerId: debit.ledgerId, debit: '100.00' },
        { ledgerId: credit.ledgerId, credit: '100.00' },
      ],
    });

    expect(result.alreadyPosted).toBe(false);
    expect(result.journalNumber).toMatch(/^JV-\d{4}$/);

    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntryId },
      include: { lines: true },
    });
    expect(entry.status).toBe(JournalStatus.POSTED);
    expect(entry.postedById).toBe(a.auth.userId);
    expect(entry.postedAt).not.toBeNull();
    expect(entry.totalDebit.toFixed(2)).toBe('100.00');
    expect(entry.lines).toHaveLength(2);
  });

  it('rejects an unbalanced entry before writing anything', async () => {
    const { debit, credit } = await twoLedgers(a);
    const before = await prisma.journalEntry.count({ where: { companyId: a.companyId } });

    await expect(
      postJournal(a.auth, {
        companyId: a.companyId,
        branchId: a.branchId,
        documentDate: new Date(),
        event: AccountingEvent.MANUAL,
        sourceEventKey: 'TEST:unbalanced:' + RUN,
        description: 'Does not balance',
        lines: [
          { ledgerId: debit.ledgerId, debit: '100.00' },
          { ledgerId: credit.ledgerId, credit: '99.00' },
        ],
      })
    ).rejects.toThrow(/does not balance/);

    expect(await prisma.journalEntry.count({ where: { companyId: a.companyId } })).toBe(before);
  });

  it('refuses a ledger belonging to another company', async () => {
    const mine = await resolveAccountingAccount(a.companyId, null, AccountMappingType.BANK);
    const theirs = await resolveAccountingAccount(b.companyId, null, AccountMappingType.SALES);

    await expect(
      postJournal(a.auth, {
        companyId: a.companyId,
        branchId: a.branchId,
        documentDate: new Date(),
        event: AccountingEvent.MANUAL,
        sourceEventKey: 'TEST:cross-tenant:' + RUN,
        description: 'Tries to post into another company chart',
        lines: [
          { ledgerId: mine.ledgerId, debit: '10.00' },
          { ledgerId: theirs.ledgerId, credit: '10.00' },
        ],
      })
    ).rejects.toThrow(/do not belong to this company/);
  });

  it('refuses to post a journal for another company', async () => {
    const theirs = await resolveAccountingAccount(b.companyId, null, AccountMappingType.SALES);
    await expect(
      postJournal(a.auth, {
        companyId: b.companyId,
        branchId: null,
        documentDate: new Date(),
        event: AccountingEvent.MANUAL,
        sourceEventKey: 'TEST:wrong-company:' + RUN,
        description: 'Posting into company B as company A',
        lines: [
          { ledgerId: theirs.ledgerId, debit: '10.00' },
          { ledgerId: theirs.ledgerId, credit: '10.00' },
        ],
      })
    ).rejects.toThrow(/another company/);
  });

  it('is idempotent on the accounting event key', async () => {
    const { debit, credit } = await twoLedgers(a);
    const input = {
      companyId: a.companyId,
      branchId: a.branchId,
      documentDate: new Date('2026-09-11'),
      event: AccountingEvent.MANUAL,
      sourceEventKey: 'TEST:idempotent:' + RUN,
      description: 'Posted twice on purpose',
      lines: [
        { ledgerId: debit.ledgerId, debit: '250.00' },
        { ledgerId: credit.ledgerId, credit: '250.00' },
      ],
    };

    const first = await postJournal(a.auth, input);
    const second = await postJournal(a.auth, input);

    expect(first.alreadyPosted).toBe(false);
    expect(second.alreadyPosted).toBe(true);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    expect(
      await prisma.journalEntry.count({
        where: { companyId: a.companyId, sourceEventKey: input.sourceEventKey },
      })
    ).toBe(1);
  });

  it('survives concurrent posts of the same event without writing two journals', async () => {
    const { debit, credit } = await twoLedgers(a);
    const input = {
      companyId: a.companyId,
      branchId: a.branchId,
      documentDate: new Date('2026-09-12'),
      event: AccountingEvent.MANUAL,
      sourceEventKey: 'TEST:concurrent:' + RUN,
      description: 'Five requests racing for one event',
      lines: [
        { ledgerId: debit.ledgerId, debit: '77.00' },
        { ledgerId: credit.ledgerId, credit: '77.00' },
      ],
    };

    // The unique index is what decides this, not a check-then-insert: all five
    // read "not posted yet" at the same moment, and Postgres lets one through.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => postJournal(a.auth, input))
    );

    const ids = new Set(results.map((r) => r.journalEntryId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.alreadyPosted)).toHaveLength(1);
    expect(
      await prisma.journalEntry.count({
        where: { companyId: a.companyId, sourceEventKey: input.sourceEventKey },
      })
    ).toBe(1);
  }, 120_000);

  it('mints a unique journal number per company', async () => {
    const numbers = await prisma.journalEntry.findMany({
      where: { companyId: a.companyId },
      select: { journalNumber: true },
    });
    expect(new Set(numbers.map((n) => n.journalNumber)).size).toBe(numbers.length);
  });

  it('allows the same journal number in a different company', async () => {
    const { debit, credit } = await twoLedgers(b);
    const result = await postJournal(b.auth, {
      companyId: b.companyId,
      branchId: b.branchId,
      documentDate: new Date('2026-09-10'),
      event: AccountingEvent.MANUAL,
      sourceEventKey: 'TEST:company-b-first:' + RUN,
      description: 'Company B first journal',
      lines: [
        { ledgerId: debit.ledgerId, debit: '5.00' },
        { ledgerId: credit.ledgerId, credit: '5.00' },
      ],
    });
    expect(result.journalNumber).toBe('JV-0001');
  });
});

/* ----------------------------------------------- immutability and reversal ---- */

describe('posted journals are immutable', () => {
  let postedId: string;

  beforeAll(async () => {
    const [debit, credit] = await Promise.all([
      resolveAccountingAccount(a.companyId, null, AccountMappingType.BANK),
      resolveAccountingAccount(a.companyId, null, AccountMappingType.SALES),
    ]);
    const result = await postJournal(a.auth, {
      companyId: a.companyId,
      branchId: a.branchId,
      documentDate: new Date('2026-09-13'),
      event: AccountingEvent.MANUAL,
      sourceEventKey: 'TEST:immutable:' + RUN,
      description: 'To be reversed, never edited',
      lines: [
        { ledgerId: debit.ledgerId, debit: '400.00' },
        { ledgerId: credit.ledgerId, credit: '400.00' },
      ],
    });
    postedId = result.journalEntryId;
  }, 120_000);

  it('refuses to delete a posted journal', async () => {
    await expect(deleteDraftJournal(a.auth, postedId)).rejects.toThrow(
      /POSTED and cannot be changed/
    );
    expect(await prisma.journalEntry.findUnique({ where: { id: postedId } })).not.toBeNull();
  });

  it('corrects by reversal, leaving the original standing', async () => {
    const reversal = await reverseJournalEntry(a.auth, postedId, 'Posted to the wrong account');

    const [original, mirror] = await Promise.all([
      prisma.journalEntry.findUniqueOrThrow({
        where: { id: postedId },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      }),
      prisma.journalEntry.findUniqueOrThrow({
        where: { id: reversal.journalEntryId },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      }),
    ]);

    expect(original.status).toBe(JournalStatus.REVERSED);
    expect(mirror.event).toBe(AccountingEvent.REVERSAL);
    expect(mirror.reversalOfId).toBe(postedId);

    // Every debit became a credit and every credit a debit.
    expect(mirror.lines[0].credit.toFixed(2)).toBe(original.lines[0].debit.toFixed(2));
    expect(mirror.lines[1].debit.toFixed(2)).toBe(original.lines[1].credit.toFixed(2));

    // Net effect on the ledger is nil.
    expect(mirror.totalDebit.toFixed(2)).toBe(original.totalCredit.toFixed(2));
  }, 120_000);

  it('nets to zero in the reports rather than applying the opposite', async () => {
    // The bug this guards: excluding the REVERSED original while keeping its
    // POSTED mirror does not cancel the posting, it applies the negative of it.
    // Both rows belong in the ledger, and the pair must sum to nothing.
    const sales = await resolveAccountingAccount(a.companyId, null, AccountMappingType.SALES);

    const lines = await prisma.journalLine.findMany({
      where: {
        ledgerId: sales.ledgerId,
        journalEntry: {
          OR: [{ id: postedId }, { reversalOfId: postedId }],
        },
      },
      select: { debit: true, credit: true },
    });

    expect(lines).toHaveLength(2);
    const net = lines.reduce(
      (acc, line) => acc.plus(line.debit).minus(line.credit),
      new Prisma.Decimal(0)
    );
    expect(net.toFixed(2)).toBe('0.00');

    // The ledger read agrees. Asserted on the pair rather than on a date window,
    // because a reversal is deliberately dated when it is raised rather than
    // back-dated onto the entry it cancels - back-dating would silently restate a
    // period that has already been reported on.
    const reversal = await prisma.journalEntry.findFirstOrThrow({
      where: { reversalOfId: postedId },
      select: { id: true },
    });
    const gl = await getGeneralLedger(a.auth, {
      ledgerId: sales.ledgerId,
      page: 1,
      limit: 200,
    });
    const pair = gl.data.filter(
      (row) => row.journalEntryId === postedId || row.journalEntryId === reversal.id
    );

    // Two rows, not one: the REVERSED original stays in the ledger.
    expect(pair).toHaveLength(2);
    const contribution = pair.reduce(
      (acc, row) => acc.plus(row.debit).minus(row.credit),
      new Prisma.Decimal(0)
    );
    expect(contribution.toFixed(2)).toBe('0.00');
  }, 120_000);

  it('refuses to reverse the same entry twice', async () => {
    await expect(reverseJournalEntry(a.auth, postedId, 'Again')).rejects.toThrow(
      /already been reversed/
    );
  });

  it('requires a reason for a reversal', async () => {
    const [debit, credit] = await Promise.all([
      resolveAccountingAccount(a.companyId, null, AccountMappingType.BANK),
      resolveAccountingAccount(a.companyId, null, AccountMappingType.SALES),
    ]);
    const entry = await postJournal(a.auth, {
      companyId: a.companyId,
      branchId: a.branchId,
      documentDate: new Date('2026-09-13'),
      event: AccountingEvent.MANUAL,
      sourceEventKey: 'TEST:needs-reason:' + RUN,
      description: 'Reversal needs a reason',
      lines: [
        { ledgerId: debit.ledgerId, debit: '1.00' },
        { ledgerId: credit.ledgerId, credit: '1.00' },
      ],
    });

    await expect(reverseJournalEntry(a.auth, entry.journalEntryId, '  ')).rejects.toThrow(
      /reason is required/
    );
  }, 120_000);

  it('refuses to reverse another company journal', async () => {
    const theirs = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: b.companyId, status: JournalStatus.POSTED },
      select: { id: true },
    });
    await expect(reverseJournalEntry(a.auth, theirs.id, 'Not mine')).rejects.toThrow(
      /not found/i
    );
  });

  it('refuses a raw unbalanced write at the database level', async () => {
    // The CHECK constraints are the guarantee the service validation explains.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "JournalLine" ("id","journalEntryId","lineNumber","ledgerId","debit","credit","createdAt")
         VALUES ('${RUN}-bad', '${postedId}', 99, (SELECT "id" FROM "Ledger" WHERE "companyId"='${a.companyId}' LIMIT 1), 5, 5, NOW())`
      )
    ).rejects.toThrow();
  });
});

/* --------------------------------------------- document-driven events (P9-15) ---- */

describe('supplier invoice accounting', () => {
  it('books the accepted payable, not the amount the supplier claimed', async () => {
    const invoice = await createSupplierInvoiceRow(a, 'INV-T1');
    const result = await postSupplierInvoiceAccounting(a.auth, invoice.id);

    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntryId },
      include: { lines: { include: { ledger: true } } },
    });

    // 52,500 was billed; 70 of 100 were accepted, so 36,750 is owed.
    expect(entry.totalCredit.toFixed(2)).toBe('36750.00');
    expect(entry.totalDebit.toFixed(2)).toBe('36750.00');

    const byCode = new Map(entry.lines.map((l) => [l.ledger.code, l]));
    expect(byCode.get('108010001')!.debit.toFixed(2)).toBe('35000.00');
    expect(byCode.get('115010001')!.debit.toFixed(2)).toBe('1750.00');
    expect(byCode.get('209020001')!.credit.toFixed(2)).toBe('36750.00');
  }, 120_000);

  it('links the journal to the invoice that caused it', async () => {
    const invoice = await prisma.document.findFirstOrThrow({
      where: { companyId: a.companyId, documentNumber: 'INV-T1' },
    });
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: a.companyId, sourceDocumentId: invoice.id },
    });
    expect(entry.sourceDocumentType).toBe(DocumentType.SUPPLIER_INVOICE);
    expect(entry.sourceReference).toBe('INV-T1');
    expect(entry.sourceEventKey).toBe(
      accountingEventKey(AccountingEvent.SUPPLIER_INVOICE, invoice.id)
    );
  });

  it('does not book the invoice twice', async () => {
    const invoice = await prisma.document.findFirstOrThrow({
      where: { companyId: a.companyId, documentNumber: 'INV-T1' },
    });
    const again = await postSupplierInvoiceAccounting(a.auth, invoice.id);
    expect(again.alreadyPosted).toBe(true);
    expect(
      await prisma.journalEntry.count({
        where: { companyId: a.companyId, sourceDocumentId: invoice.id },
      })
    ).toBe(1);
  }, 120_000);
});

describe('supplier payment accounting', () => {
  it('settles the payable against the account the money left', async () => {
    const invoice = await prisma.document.findFirstOrThrow({
      where: { companyId: a.companyId, documentNumber: 'INV-T1' },
    });
    const payment = await prisma.payment.create({
      data: {
        companyId: a.companyId,
        branchId: a.branchId,
        supplierId: a.supplierId,
        paymentNumber: 'PAY-T1',
        amount: '36750.00',
        method: PaymentMethod.BANK_TRANSFER,
        paymentDate: new Date('2026-09-06'),
        createdById: a.userId,
      },
    });
    await prisma.paymentAllocation.create({
      data: { paymentId: payment.id, documentId: invoice.id, allocatedAmount: '36750.00' },
    });

    const result = await postSupplierPaymentAccounting(a.auth, payment.id);
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntryId },
      include: { lines: { include: { ledger: true } } },
    });

    const byCode = new Map(entry.lines.map((l) => [l.ledger.code, l]));
    expect(byCode.get('209020001')!.debit.toFixed(2)).toBe('36750.00');
    expect(byCode.get('112010001')!.credit.toFixed(2)).toBe('36750.00');
    expect(entry.sourcePaymentId).toBe(payment.id);
  }, 120_000);

  it('refuses a payment allocated to nothing', async () => {
    const payment = await prisma.payment.create({
      data: {
        companyId: a.companyId,
        branchId: a.branchId,
        supplierId: a.supplierId,
        paymentNumber: 'PAY-T2',
        amount: '100.00',
        method: PaymentMethod.CASH,
        createdById: a.userId,
      },
    });
    await expect(postSupplierPaymentAccounting(a.auth, payment.id)).rejects.toThrow(
      /not allocated to any supplier invoice/
    );
  }, 120_000);
});

describe('sales and COGS accounting', () => {
  let dispensingId: string;

  beforeAll(async () => {
    const document = await createDispensingRow(a, 'DSP-T1');
    dispensingId = document.id;
  }, 120_000);

  it('books revenue net of the tax collected on the sale', async () => {
    const result = await postSalesAccounting(a.auth, dispensingId);
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntryId },
      include: { lines: { include: { ledger: true } } },
    });

    const byCode = new Map(entry.lines.map((l) => [l.ledger.code, l]));
    expect(byCode.get('112010001')!.debit.toFixed(2)).toBe('3412.50');
    expect(byCode.get('401010001')!.credit.toFixed(2)).toBe('3250.00');
    expect(byCode.get('213010001')!.credit.toFixed(2)).toBe('162.50');
  }, 120_000);

  it('takes COGS from the stock ledger, never from the selling price', async () => {
    const result = await postCOGSAccounting(a.auth, dispensingId);
    const entry = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: result.journalEntryId },
      include: { lines: { include: { ledger: true } } },
    });

    // 5 units at the 500 batch cost. At the 650 selling price it would be 3,250.
    expect(entry.totalDebit.toFixed(2)).toBe('2500.00');
    expect(entry.totalDebit.toFixed(2)).not.toBe('3250.00');

    const byCode = new Map(entry.lines.map((l) => [l.ledger.code, l]));
    expect(byCode.get('501000001')!.debit.toFixed(2)).toBe('2500.00');
    expect(byCode.get('108010001')!.credit.toFixed(2)).toBe('2500.00');
  }, 120_000);

  it('keeps the sale and its cost as two separate entries', async () => {
    const entries = await prisma.journalEntry.findMany({
      where: { companyId: a.companyId, sourceDocumentId: dispensingId },
      select: { event: true },
    });
    expect(entries.map((e) => e.event).sort()).toEqual([
      AccountingEvent.COGS,
      AccountingEvent.SALES,
    ]);
  });

  it('refuses to book COGS with no stock movement behind it', async () => {
    const document = await prisma.document.create({
      data: {
        companyId: a.companyId,
        branchId: a.branchId,
        documentNumber: 'DSP-T2',
        documentType: DocumentType.DISPENSING,
        status: DocumentStatus.COMPLETED,
        documentDate: new Date(),
        subtotal: '10.00',
        taxAmount: '0.00',
        totalAmount: '10.00',
        createdById: a.userId,
      },
    });
    await expect(postCOGSAccounting(a.auth, document.id)).rejects.toThrow(
      /no stock movements/
    );
  }, 120_000);
});

/* --------------------------------------------- stock transfer raises nothing ---- */

describe('internal stock transfer', () => {
  it('produces no journal, and no revenue or expense', async () => {
    const transfer = await prisma.document.create({
      data: {
        companyId: a.companyId,
        sourceBranchId: a.branchId,
        destinationBranchId: a.otherBranchId,
        documentNumber: 'TRF-T1',
        documentType: DocumentType.STOCK_TRANSFER,
        status: DocumentStatus.RECEIVED,
        documentDate: new Date('2026-09-09'),
        subtotal: '15000.00',
        totalAmount: '15000.00',
        createdById: a.userId,
      },
    });

    const outcome = await postDocumentAccounting(a.auth, transfer.id);

    expect(outcome.journals).toHaveLength(0);
    expect(outcome.skipped[0].reason).toMatch(/no revenue is earned/i);
    expect(
      await prisma.journalEntry.count({
        where: { companyId: a.companyId, sourceDocumentId: transfer.id },
      })
    ).toBe(0);
  }, 120_000);

  it('leaves the income and expense accounts untouched', async () => {
    const revenueLines = await prisma.journalLine.count({
      where: {
        journalEntry: {
          companyId: a.companyId,
          sourceDocument: { documentType: DocumentType.STOCK_TRANSFER },
        },
      },
    });
    expect(revenueLines).toBe(0);
  });
});

/* ----------------------------------------------------- reports (P17 to P20) ---- */

describe('financial reports', () => {
  it('the general ledger runs a balance from the lines', async () => {
    const inventory = await resolveAccountingAccount(
      a.companyId,
      null,
      AccountMappingType.INVENTORY
    );
    const gl = await getGeneralLedger(a.auth, {
      ledgerId: inventory.ledgerId,
      ...SCENARIO,
      page: 1,
      limit: 100,
    });

    // 35,000 in from the invoice, 2,500 out to COGS.
    expect(gl.closingBalance).toBe('32500.00');
    expect(gl.data.at(-1)!.runningBalance).toBe(gl.closingBalance);
    expect(gl.data.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('the general ledger excludes journals that are not posted', async () => {
    const bank = await resolveAccountingAccount(a.companyId, null, AccountMappingType.BANK);
    const sales = await resolveAccountingAccount(a.companyId, null, AccountMappingType.SALES);

    const before = await getGeneralLedger(a.auth, {
      ledgerId: bank.ledgerId,
      page: 1,
      limit: 200,
    });

    await postJournal(a.auth, {
      companyId: a.companyId,
      branchId: a.branchId,
      documentDate: new Date('2026-09-14'),
      event: AccountingEvent.MANUAL,
      sourceEventKey: 'TEST:draft:' + RUN,
      description: 'A draft that must never reach a report',
      status: JournalStatus.DRAFT,
      lines: [
        { ledgerId: bank.ledgerId, debit: '999999.00' },
        { ledgerId: sales.ledgerId, credit: '999999.00' },
      ],
    });

    const after = await getGeneralLedger(a.auth, {
      ledgerId: bank.ledgerId,
      page: 1,
      limit: 200,
    });
    expect(after.closingBalance).toBe(before.closingBalance);
  }, 120_000);

  it('the trial balance balances', async () => {
    const tb = await getTrialBalance(a.auth, {});
    expect(tb.isBalanced).toBe(true);
    expect(tb.totals.difference).toBe('0.00');
    expect(tb.integrityError).toBeNull();
    expect(tb.totals.totalDebit).toBe(tb.totals.totalCredit);
  }, 120_000);

  it('the profit and loss excludes tax collected from revenue', async () => {
    const pl = await getProfitAndLoss(a.auth, SCENARIO);
    expect(pl.totalIncome).toBe('3250.00');
    expect(pl.totalIncome).not.toBe('3412.50');
    expect(pl.totalExpenses).toBe('2500.00');
    expect(pl.netProfit).toBe('750.00');
    expect(pl.isProfit).toBe(true);
  }, 120_000);

  it('the balance sheet satisfies the accounting equation', async () => {
    const bs = await getBalanceSheet(a.auth, SCENARIO);
    expect(bs.isBalanced).toBe(true);
    expect(bs.totals.difference).toBe('0.00');
    expect(bs.integrityError).toBeNull();
    expect(bs.totals.totalAssets).toBe(bs.totals.totalLiabilitiesAndEquity);
  }, 120_000);

  it('the balance sheet carries the period result into equity', async () => {
    const [bs, pl] = await Promise.all([
      getBalanceSheet(a.auth, SCENARIO),
      getProfitAndLoss(a.auth, SCENARIO),
    ]);
    expect(bs.equity.retainedResultForPeriod).toBe(pl.netProfit);
  }, 120_000);

  it('a date range narrows what is reported', async () => {
    const empty = await getTrialBalance(a.auth, {
      fromDate: new Date('2020-01-01'),
      toDate: new Date('2020-12-31'),
    });
    expect(empty.rows).toHaveLength(0);
    expect(empty.totals.totalDebit).toBe('0.00');
    expect(empty.isBalanced).toBe(true);
  }, 120_000);
});

/* ------------------------------------------------ isolation (P23) ---- */

describe('company isolation', () => {
  it('company A journals never reach company B reports', async () => {
    const [fromA, fromB] = await Promise.all([
      getTrialBalance(a.auth, {}),
      getTrialBalance(b.auth, {}),
    ]);

    expect(Number(fromA.totals.totalDebit)).toBeGreaterThan(0);
    // Company B has one tiny manual entry of its own and none of company A's.
    expect(Number(fromB.totals.totalDebit)).toBeLessThan(Number(fromA.totals.totalDebit));

    const aLedgerIds = new Set(fromA.rows.map((r) => r.ledgerId));
    for (const row of fromB.rows) {
      expect(aLedgerIds.has(row.ledgerId)).toBe(false);
    }
  }, 120_000);

  it('a journal of another company cannot be read', async () => {
    const theirs = await prisma.journalEntry.findFirstOrThrow({
      where: { companyId: b.companyId },
      select: { id: true },
    });
    const { getJournalEntry } = await import('../../services/accounting/journal.service');
    await expect(getJournalEntry(a.auth, theirs.id)).rejects.toThrow(/not found/i);
  });

  it('no journal line ever points at another company chart', async () => {
    const strays = await prisma.journalLine.count({
      where: {
        journalEntry: { companyId: a.companyId },
        ledger: { companyId: { not: a.companyId } },
      },
    });
    expect(strays).toBe(0);
  });

  it('a document of another company cannot be posted', async () => {
    const invoice = await createSupplierInvoiceRow(b, 'INV-B1');
    await expect(postSupplierInvoiceAccounting(a.auth, invoice.id)).rejects.toThrow(/not found/i);
  }, 120_000);
});

describe('branch isolation', () => {
  it('a branch-scoped user sees only their own branch postings', async () => {
    const scoped = await getTrialBalance(a.branchAuth, {});
    const whole = await getTrialBalance(a.auth, {});

    // Every posting so far belongs to the main branch, which this user cannot see.
    expect(Number(scoped.totals.totalDebit)).toBeLessThan(Number(whole.totals.totalDebit));
    expect(scoped.isBalanced).toBe(true);
  }, 120_000);

  it('a branch-scoped user is refused a branch they do not hold', async () => {
    await expect(getTrialBalance(a.branchAuth, { branchId: a.branchId })).rejects.toThrow(
      /Access denied for this branch/
    );
  });

  it('a branch view of its own branch is allowed', async () => {
    const report = await getTrialBalance(a.branchAuth, { branchId: a.otherBranchId });
    expect(report.isBalanced).toBe(true);
  }, 120_000);

  it('a branch-scoped user cannot post accounting for another branch', async () => {
    const document = await createDispensingRow(a, 'DSP-T3', a.branchId);
    await expect(postSalesAccounting(a.branchAuth, document.id)).rejects.toThrow(
      /Access denied for this branch/
    );
  }, 120_000);
});
