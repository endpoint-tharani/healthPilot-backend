/**
 * Asserts that the seeded tenant's books are what they claim to be, and prints
 * the full accounting reconciliation for the demo scenario.
 *
 * It reads the database directly and needs no running server. Every figure is
 * summed from posted journal lines and cross-checked against the business
 * documents that caused them, so a regression in a posting rule shows up as a
 * failed assertion rather than as a report that quietly prints a different
 * number. Nothing here re-implements a business rule - the reports are produced
 * by the same service functions the API serves.
 *
 *   npm run verify:accounting
 *
 * Exits non-zero on the first failure, so CI can gate on it.
 */
import {
  AccountingEvent,
  BranchScopeType,
  BranchType,
  DocumentType,
  JournalStatus,
  Prisma,
} from '@prisma/client';
import { prisma, disconnectDatabase } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { permissionsForRole } from '../constants/permissions';
import {
  describeResolvedMappings,
  getMappingHealth,
} from '../services/accounting/accountMapping.service';
import {
  getSupplierLedger,
  getSupplierOutstanding,
} from '../services/accounting/supplierLedger.service';
import { countChart } from '../services/accounting/chartOfAccounts.service';
import { getGeneralLedger } from '../services/accounting/generalLedger.service';
import {
  getBalanceSheet,
  getProfitAndLoss,
  getTrialBalance,
} from '../services/accounting/reports.service';

const DEMO_COMPANY_CODE = 'COMP-HEALTHPILOT';
const ISOLATION_COMPANY_CODE = 'COMP-OTHERCARE';
const ZERO = new Prisma.Decimal(0);

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  checks += 1;
  if (condition) {
    console.log('PASS ' + name);
  } else {
    failures += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  }
}

function equals(name: string, actual: string | null | undefined, expected: string) {
  check(name + ' = ' + expected, actual === expected, { actual, expected });
}

function section(title: string) {
  console.log('\n--- ' + title + ' ---');
}

/** The identity a signed-in user would carry, built as the seed builds it. */
async function actingAs(email: string): Promise<AuthContext> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: {
      branch: { select: { id: true, type: true } },
      branchAccess: { select: { branch: { select: { id: true, type: true } } } },
    },
  });
  const hasAllBranches = user.branchScope === BranchScopeType.ALL_BRANCHES;
  const scoped = [
    ...(user.branch ? [user.branch] : []),
    ...user.branchAccess.map((a) => a.branch),
  ];
  return {
    userId: user.id,
    companyId: user.companyId,
    role: user.role,
    scopeType: user.branchScope,
    hasAllBranches,
    allowedBranchIds: hasAllBranches ? [] : Array.from(new Set(scoped.map((b) => b.id))),
    hasCentralWarehouseAccess:
      hasAllBranches || scoped.some((b) => b.type === BranchType.CENTRAL_WAREHOUSE),
    permissions: permissionsForRole(user.role),
  };
}

async function main() {
  console.log('--- HealthPilot accounting verification and reconciliation ---');

  const company = await prisma.company.findUnique({
    where: { code: DEMO_COMPANY_CODE },
    select: {
      id: true,
      name: true,
      accountingTemplateKey: true,
      accountingTemplateVersion: true,
      accountingInitializedAt: true,
    },
  });
  if (!company) {
    throw new Error('Demo company ' + DEMO_COMPANY_CODE + ' not found. Run `npm run prisma:seed`.');
  }
  const companyId = company.id;
  const accountant = await actingAs('admin@healthpilot.ai');

  /* ----------------------------------------------- 1. chart of accounts ---- */

  section('1. Chart of accounts (IND_AS)');

  equals('Template key', company.accountingTemplateKey, 'IND_AS');
  equals('Template version', company.accountingTemplateVersion, '1.1.0');
  check('Accounting initialised', company.accountingInitializedAt !== null);

  const counts = await countChart(companyId);
  console.log('INFO chart: ' + JSON.stringify(counts));
  check('Five natures (AS, LI, EQ, IN, EX)', counts.natures === 5, counts.natures);
  check('Seven nature types', counts.natureTypes === 7, counts.natureTypes);
  check('Forty heads', counts.heads === 40, counts.heads);
  check('Forty-one groups', counts.groups === 41, counts.groups);
  check('Ten sub-groups', counts.subGroups === 10, counts.subGroups);
  check('Three hundred and four ledgers', counts.ledgers === 304, counts.ledgers);
  check('Fifteen mappings', counts.mappings === 15, counts.mappings);

  // The codes the reporting format owns must still mean what it says they mean.
  // These are positional: 1 08 00 is the eighth head under Asset, and every
  // ledger beneath it starts 1 08.
  for (const [code, name] of [
    ['10800', 'Inventories'],
    ['11000', 'Trade Receivables'],
    ['11100', 'Cash & Cash Equivalents'],
    ['11200', 'Bank Balances'],
    ['20900', 'Trade Payables'],
    ['40100', 'Revenue from Operations'],
    ['50100', 'Cost of Materials Consumed'],
  ] as const) {
    const head = await prisma.accountHead.findUnique({
      where: { companyId_code: { companyId, code } },
      select: { name: true },
    });
    equals('Head ' + code, head?.name, name);
  }

  for (const [code, name] of [
    ['401010001', 'Sales'],
    ['501000001', 'COGS'],
  ] as const) {
    const ledger = await prisma.ledger.findUnique({
      where: { companyId_code: { companyId, code } },
      select: { name: true, isLocked: true },
    });
    equals('Ledger ' + code, ledger?.name, name);
    check('Ledger ' + code + ' is locked by the reporting format', ledger?.isLocked === true);
  }

  /* -------------------------------------------------------- 2. mappings ---- */

  section('2. Account mappings resolve');

  const resolved = await describeResolvedMappings(companyId);
  for (const row of resolved) {
    if (row.error) {
      check('Mapping ' + row.mappingType + ' resolves', false, row.error);
    } else {
      console.log(
        'PASS Mapping ' +
          row.mappingType.padEnd(14) +
          ' -> ' +
          row.resolved!.ledgerCode +
          ' ' +
          row.resolved!.ledgerName +
          ' (via ' +
          row.resolved!.via +
          ')'
      );
      checks += 1;
    }
  }
  const byType = new Map(resolved.map((r) => [r.mappingType, r.resolved]));
  equals('SALES resolves to', byType.get('SALES')?.ledgerCode, '401010001');
  equals('DIRECT_COST resolves to', byType.get('DIRECT_COST')?.ledgerCode, '501000001');
  equals('PURCHASE resolves to', byType.get('PURCHASE')?.ledgerCode, '502010001');
  equals('INVENTORY resolves under 10800', byType.get('INVENTORY')?.headCode, '10800');
  equals('VENDOR resolves under 20900', byType.get('VENDOR')?.headCode, '20900');
  equals('BANK resolves under 11200', byType.get('BANK')?.headCode, '11200');
  equals('CASH resolves under 11100', byType.get('CASH')?.headCode, '11100');

  /* ------------------------------------------------ 3. journals raised ---- */

  section('3. Journal entries');

  const journals = await prisma.journalEntry.findMany({
    where: { companyId },
    orderBy: { journalNumber: 'asc' },
    include: {
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: { ledger: { select: { code: true, name: true } } },
      },
      sourceDocument: { select: { documentNumber: true, documentType: true } },
      sourcePayment: { select: { paymentNumber: true } },
      createdBy: { select: { email: true } },
      postedBy: { select: { email: true } },
    },
  });

  check('Four journals were raised', journals.length === 4, journals.map((j) => j.journalNumber));

  for (const journal of journals) {
    console.log(
      '\n  ' +
        journal.journalNumber +
        '  ' +
        journal.documentDate.toISOString().slice(0, 10) +
        '  ' +
        journal.event +
        '  [' +
        journal.status +
        ']  source: ' +
        (journal.sourceDocument?.documentNumber ?? journal.sourcePayment?.paymentNumber ?? '-')
    );
    for (const line of journal.lines) {
      console.log(
        '      ' +
          line.ledger.code.padEnd(6) +
          line.ledger.name.padEnd(34) +
          'Dr ' +
          line.debit.toFixed(2).padStart(12) +
          '   Cr ' +
          line.credit.toFixed(2).padStart(12)
      );
    }
    check(
      journal.journalNumber + ' balances',
      journal.totalDebit.equals(journal.totalCredit),
      { debit: journal.totalDebit.toFixed(2), credit: journal.totalCredit.toFixed(2) }
    );
    check(journal.journalNumber + ' has at least two lines', journal.lines.length >= 2);
    check(
      journal.journalNumber + ' records who posted it',
      journal.postedById !== null && journal.postedAt !== null
    );
    for (const line of journal.lines) {
      const oneSided =
        (line.debit.greaterThan(0) && line.credit.isZero()) ||
        (line.credit.greaterThan(0) && line.debit.isZero());
      check(
        journal.journalNumber + ' line ' + line.lineNumber + ' carries exactly one side',
        oneSided,
        { debit: line.debit.toFixed(2), credit: line.credit.toFixed(2) }
      );
    }
  }

  const journalByEvent = new Map(journals.map((j) => [j.event, j]));

  /* --------------------------------------- 4. the scenario's four postings ---- */

  section('4. Scenario postings match the expected figures');

  const invoiceJournal = journalByEvent.get(AccountingEvent.SUPPLIER_INVOICE);
  equals('Supplier invoice journal total', invoiceJournal?.totalDebit.toFixed(2), '36750.00');
  const invoiceLines = new Map(
    (invoiceJournal?.lines ?? []).map((l) => [l.ledger.code, l])
  );
  const inventoryCode = byType.get('INVENTORY')!.ledgerCode;
  const inputTaxCode = byType.get('INPUT_TAX')?.ledgerCode ?? byType.get('TAX')!.ledgerCode;
  const vendorCode = byType.get('VENDOR')!.ledgerCode;
  equals(
    '  Dr Inventory (' + inventoryCode + ')',
    invoiceLines.get(inventoryCode)?.debit.toFixed(2),
    '35000.00'
  );
  equals(
    '  Dr Input tax (' + inputTaxCode + ')',
    invoiceLines.get(inputTaxCode)?.debit.toFixed(2),
    '1750.00'
  );
  equals(
    '  Cr Accounts payable (' + vendorCode + ')',
    invoiceLines.get(vendorCode)?.credit.toFixed(2),
    '36750.00'
  );

  const paymentJournal = journalByEvent.get(AccountingEvent.SUPPLIER_PAYMENT);
  equals('Supplier payment journal total', paymentJournal?.totalDebit.toFixed(2), '36750.00');
  const paymentLines = new Map((paymentJournal?.lines ?? []).map((l) => [l.ledger.code, l]));
  const bankCode = byType.get('BANK')!.ledgerCode;
  equals('  Dr Accounts payable', paymentLines.get(vendorCode)?.debit.toFixed(2), '36750.00');
  equals('  Cr Bank (' + bankCode + ')', paymentLines.get(bankCode)?.credit.toFixed(2), '36750.00');

  const salesJournal = journalByEvent.get(AccountingEvent.SALES);
  equals('Sales journal total', salesJournal?.totalDebit.toFixed(2), '3412.50');
  const salesLines = new Map((salesJournal?.lines ?? []).map((l) => [l.ledger.code, l]));
  const outputTaxCode = byType.get('OUTPUT_TAX')?.ledgerCode ?? byType.get('TAX')!.ledgerCode;
  equals('  Dr Bank', salesLines.get(bankCode)?.debit.toFixed(2), '3412.50');
  equals('  Cr Sales (401010001)', salesLines.get('401010001')?.credit.toFixed(2), '3250.00');
  equals(
    '  Cr Output tax (' + outputTaxCode + ')',
    salesLines.get(outputTaxCode)?.credit.toFixed(2),
    '162.50'
  );

  const cogsJournal = journalByEvent.get(AccountingEvent.COGS);
  equals('COGS journal total', cogsJournal?.totalDebit.toFixed(2), '2500.00');
  const cogsLines = new Map((cogsJournal?.lines ?? []).map((l) => [l.ledger.code, l]));
  equals('  Dr COGS (501000001)', cogsLines.get('501000001')?.debit.toFixed(2), '2500.00');
  equals('  Cr Inventory', cogsLines.get(inventoryCode)?.credit.toFixed(2), '2500.00');

  // COGS must come from the stock ledger, never from the selling price. 5 units at
  // the 650 selling price would be 3,250; at the 500 batch cost it is 2,500.
  const dispensingMovements = await prisma.inventoryTransaction.aggregate({
    where: { companyId, document: { documentType: DocumentType.DISPENSING } },
    _sum: { totalCost: true },
  });
  const ledgerCost = (dispensingMovements._sum.totalCost ?? ZERO).absoluteValue();
  equals('COGS equals the stock ledger cost of the issue', ledgerCost.toFixed(2), '2500.00');
  check(
    'COGS is not derived from the selling price (would be 3250.00)',
    cogsJournal?.totalDebit.toFixed(2) !== '3250.00'
  );

  /* ------------------------------------- 5. what deliberately has no journal ---- */

  section('5. Events that deliberately raise no journal');

  const transfer = await prisma.document.findFirst({
    where: { companyId, documentType: DocumentType.STOCK_TRANSFER },
    select: { id: true, documentNumber: true },
  });
  const transferJournals = transfer
    ? await prisma.journalEntry.count({ where: { companyId, sourceDocumentId: transfer.id } })
    : -1;
  check(
    'Internal stock transfer ' + (transfer?.documentNumber ?? '?') + ' raised no journal',
    transferJournals === 0,
    transferJournals
  );

  const revenueOnTransfer = await prisma.journalLine.count({
    where: {
      journalEntry: { companyId, sourceDocument: { documentType: DocumentType.STOCK_TRANSFER } },
    },
  });
  check('No revenue or expense line exists for any transfer', revenueOnTransfer === 0);

  const receipt = await prisma.document.findFirst({
    where: { companyId, documentType: DocumentType.GOODS_RECEIPT },
    select: { id: true, documentNumber: true },
  });
  const receiptJournals = receipt
    ? await prisma.journalEntry.count({ where: { companyId, sourceDocumentId: receipt.id } })
    : -1;
  check(
    'Goods receipt ' +
      (receipt?.documentNumber ?? '?') +
      ' raised no journal (payable recognised at invoice stage)',
    receiptJournals === 0,
    receiptJournals
  );

  const creditNote = await prisma.document.findFirst({
    where: { companyId, documentType: DocumentType.CREDIT_NOTE },
    select: { id: true, documentNumber: true, totalAmount: true },
  });
  equals('Credit note value', creditNote?.totalAmount.toFixed(2), '15750.00');
  const creditNoteJournals = creditNote
    ? await prisma.journalEntry.count({ where: { companyId, sourceDocumentId: creditNote.id } })
    : -1;
  check(
    'Credit note raised no journal: it clears disputed value the invoice journal never booked',
    creditNoteJournals === 0,
    creditNoteJournals
  );
  console.log(
    'INFO The invoice journal books the accepted payable of 36,750 rather than the 52,500 claimed, ' +
      'so the 15,750 the credit note clears was never a liability in the books. Booking it again ' +
      'would take payables below what is owed.'
  );

  /* ------------------------------------------------------- 6. idempotency ---- */

  section('6. No duplicate accounting');

  const duplicateKeys = await prisma.$queryRaw<{ sourceEventKey: string; n: bigint }[]>`
    SELECT "sourceEventKey", COUNT(*) AS n
    FROM "JournalEntry"
    WHERE "companyId" = ${companyId}
    GROUP BY "sourceEventKey"
    HAVING COUNT(*) > 1
  `;
  check('Every accounting event has exactly one journal', duplicateKeys.length === 0, duplicateKeys);

  const perDocument = await prisma.$queryRaw<{ documentNumber: string; event: string; n: bigint }[]>`
    SELECT d."documentNumber", j."event"::text AS event, COUNT(*) AS n
    FROM "JournalEntry" j
    JOIN "Document" d ON d."id" = j."sourceDocumentId"
    WHERE j."companyId" = ${companyId}
    GROUP BY d."documentNumber", j."event"
    HAVING COUNT(*) > 1
  `;
  check('No document has two journals for the same event', perDocument.length === 0, perDocument);

  /* --------------------------------------------------- 7. document linking ---- */

  section('7. Journals trace back to their source document');

  for (const journal of journals) {
    const traceable =
      journal.sourceDocumentId !== null || journal.sourcePaymentId !== null;
    check(journal.journalNumber + ' names its source', traceable, {
      document: journal.sourceDocument?.documentNumber,
      payment: journal.sourcePayment?.paymentNumber,
    });
  }

  const orphanLines = await prisma.journalLine.count({
    where: { journalEntry: { companyId }, ledger: { companyId: { not: companyId } } },
  });
  check('Every journal line points at a ledger of its own company', orphanLines === 0);

  /* --------------------------------------------------- 8. general ledger ---- */

  section('8. General ledger');

  const inventoryLedger = await prisma.ledger.findUniqueOrThrow({
    where: { companyId_code: { companyId, code: inventoryCode } },
    select: { id: true, code: true, name: true },
  });
  const gl = await getGeneralLedger(accountant, {
    ledgerId: inventoryLedger.id,
    page: 1,
    limit: 50,
  });
  console.log(
    '\n  ' +
      inventoryLedger.code +
      ' ' +
      inventoryLedger.name +
      '   opening ' +
      gl.openingBalance +
      '   closing ' +
      gl.closingBalance
  );
  for (const row of gl.data) {
    console.log(
      '      ' +
        row.date.toISOString().slice(0, 10) +
        '  ' +
        row.journalNumber +
        '  ' +
        (row.sourceDocument ?? '-').padEnd(10) +
        ' Dr ' +
        row.debit.padStart(11) +
        '  Cr ' +
        row.credit.padStart(11) +
        '  bal ' +
        row.runningBalance.padStart(11)
    );
  }
  // 35,000 in from the invoice, 2,500 out to COGS.
  equals('Inventory ledger closing balance', gl.closingBalance, '32500.00');
  check('Inventory ledger has two movements', gl.data.length === 2, gl.data.length);
  check(
    'Running balance is computed from the lines, not stored',
    gl.data.at(-1)?.runningBalance === gl.closingBalance
  );

  /* --------------------------------------------------- 9. trial balance ---- */

  section('9. Trial balance');

  const trialBalance = await getTrialBalance(accountant, {});
  console.log('\n  Code   Account                             Nature        Debit          Credit');
  for (const row of trialBalance.rows) {
    console.log(
      '  ' +
        row.code.padEnd(6) +
        ' ' +
        row.name.slice(0, 34).padEnd(35) +
        row.natureCode.padEnd(13) +
        row.debit.padStart(12) +
        '   ' +
        row.credit.padStart(12)
    );
  }
  console.log(
    '  ' +
      ''.padEnd(55) +
      trialBalance.totals.totalDebit.padStart(12) +
      '   ' +
      trialBalance.totals.totalCredit.padStart(12)
  );
  console.log('  Difference: ' + trialBalance.totals.difference);

  check('Trial balance balances', trialBalance.isBalanced, trialBalance.totals);
  equals('Trial balance difference', trialBalance.totals.difference, '0.00');
  check('No integrity error reported', trialBalance.integrityError === null);

  /* ------------------------------------------------------ 10. profit & loss ---- */

  section('10. Profit and loss');

  const pl = await getProfitAndLoss(accountant, {});
  console.log('\n  INCOME');
  for (const s of pl.income.sections) {
    for (const h of s.heads) {
      console.log('    ' + h.code.padEnd(9) + h.name.padEnd(38) + h.amount.padStart(12));
    }
  }
  console.log('    ' + 'Total income'.padEnd(47) + pl.totalIncome.padStart(12));
  console.log('  EXPENSES');
  for (const s of pl.expenses.sections) {
    for (const h of s.heads) {
      console.log('    ' + h.code.padEnd(9) + h.name.padEnd(38) + h.amount.padStart(12));
    }
  }
  console.log('    ' + 'Total expenses'.padEnd(47) + pl.totalExpenses.padStart(12));
  console.log('  ' + 'NET PROFIT'.padEnd(49) + pl.netProfit.padStart(12));

  equals('Total income (revenue from operations)', pl.totalIncome, '3250.00');
  equals('Total expenses (cost of material consumed)', pl.totalExpenses, '2500.00');
  equals('Net profit', pl.netProfit, '750.00');
  check('Output tax is not counted as income', pl.totalIncome !== '3412.50');

  /* ------------------------------------------------------ 11. balance sheet ---- */

  section('11. Balance sheet');

  const bs = await getBalanceSheet(accountant, {});
  console.log('\n  ASSETS');
  for (const s of bs.assets.sections) {
    console.log('    ' + s.name);
    for (const h of s.heads) {
      console.log('      ' + h.code.padEnd(9) + h.name.padEnd(36) + h.amount.padStart(12));
    }
  }
  console.log('    ' + 'Total assets'.padEnd(49) + bs.totals.totalAssets.padStart(12));
  console.log('  LIABILITIES');
  for (const s of bs.liabilities.sections) {
    console.log('    ' + s.name);
    for (const h of s.heads) {
      console.log('      ' + h.code.padEnd(9) + h.name.padEnd(36) + h.amount.padStart(12));
    }
  }
  console.log('    ' + 'Total liabilities'.padEnd(49) + bs.totals.totalLiabilities.padStart(12));
  console.log('  EQUITY');
  console.log(
    '      ' + 'Retained result for the period'.padEnd(45) + bs.equity.retainedResultForPeriod.padStart(12)
  );
  console.log('    ' + 'Total equity'.padEnd(49) + bs.totals.totalEquity.padStart(12));
  console.log(
    '  ' + 'TOTAL LIABILITIES AND EQUITY'.padEnd(49) + bs.totals.totalLiabilitiesAndEquity.padStart(12)
  );
  console.log('  Difference: ' + bs.totals.difference);

  check('Assets equal liabilities plus equity', bs.isBalanced, bs.totals);
  equals('Balance sheet difference', bs.totals.difference, '0.00');
  equals('Retained result equals the P&L net profit', bs.equity.retainedResultForPeriod, pl.netProfit);
  check('No integrity error reported', bs.integrityError === null);

  /* --------------------------------------------- 12. cross-tenant isolation ---- */

  section('12. Company and branch isolation');

  const otherCompany = await prisma.company.findUnique({
    where: { code: ISOLATION_COMPANY_CODE },
    select: { id: true },
  });
  if (otherCompany) {
    const otherJournals = await prisma.journalEntry.count({
      where: { companyId: otherCompany.id },
    });
    check('The isolation tenant has no journals of its own', otherJournals === 0, otherJournals);

    const otherAccountant = await actingAs('admin@othercare.ai');
    const otherTrialBalance = await getTrialBalance(otherAccountant, {});
    equals(
      "Company B's trial balance shows none of company A's debits",
      otherTrialBalance.totals.totalDebit,
      '0.00'
    );
    check("Company B's trial balance is empty", otherTrialBalance.rows.length === 0);

    const otherChart = await countChart(otherCompany.id);
    check(
      'Company B has its own chart of accounts, separate from A',
      otherChart.ledgers === 38,
      otherChart
    );

    const crossTenantLines = await prisma.journalLine.count({
      where: {
        journalEntry: { companyId },
        ledger: { companyId: otherCompany.id },
      },
    });
    check("No line of company A points at company B's chart", crossTenantLines === 0);
  }

  // A branch pharmacist sees only their own branch's postings.
  const branchUser = await actingAs('brancha@healthpilot.ai');
  const branchTrialBalance = await getTrialBalance(branchUser, {});
  const branchTotal = branchTrialBalance.totals.totalDebit;
  console.log('INFO Branch A trial balance debit total: ' + branchTotal);
  check(
    "Branch A's view excludes the central warehouse's supplier invoice",
    branchTrialBalance.rows.every((r) => r.code !== vendorCode) ||
      Number(branchTotal) < Number(trialBalance.totals.totalDebit),
    { branchTotal, companyTotal: trialBalance.totals.totalDebit }
  );
  check('A branch view still balances', branchTrialBalance.isBalanced, branchTrialBalance.totals);

  /* ------------------------------------------------------ 13. reconciliation ---- */

  section('13. Reconciliation against the business documents');

  const invoice = await prisma.document.findFirstOrThrow({
    where: { companyId, documentType: DocumentType.SUPPLIER_INVOICE },
    select: { documentNumber: true, totalAmount: true, disputedAmount: true, paidAmount: true },
  });
  const supplierPayment = await prisma.payment.findFirstOrThrow({
    where: { companyId, supplierId: { not: null } },
    select: { paymentNumber: true, amount: true },
  });
  const dispensing = await prisma.document.findFirstOrThrow({
    where: { companyId, documentType: DocumentType.DISPENSING },
    select: { documentNumber: true, subtotal: true, taxAmount: true, totalAmount: true },
  });

  console.log('\n  Document                         Business value    Journal value');
  const rows: [string, string, string][] = [
    [
      invoice.documentNumber + ' accepted payable',
      invoice.totalAmount.minus(invoice.disputedAmount).toFixed(2),
      invoiceJournal?.totalCredit.toFixed(2) ?? '-',
    ],
    [
      supplierPayment.paymentNumber + ' paid',
      supplierPayment.amount.toFixed(2),
      paymentJournal?.totalDebit.toFixed(2) ?? '-',
    ],
    [
      dispensing.documentNumber + ' sale',
      dispensing.totalAmount.toFixed(2),
      salesJournal?.totalDebit.toFixed(2) ?? '-',
    ],
    [dispensing.documentNumber + ' cost', ledgerCost.toFixed(2), cogsJournal?.totalDebit.toFixed(2) ?? '-'],
  ];
  for (const [label, business, journal] of rows) {
    console.log('  ' + label.padEnd(34) + business.padStart(14) + journal.padStart(17));
    check('Reconciles: ' + label, business === journal, { business, journal });
  }

  // The same scope the reports use: drafts out, reversed entries in. A reversed
  // journal and its mirror both stay in the ledger and net to zero; counting only
  // the mirror would apply the opposite of the original rather than cancelling it.
  const totals = await prisma.journalLine.aggregate({
    where: {
      journalEntry: {
        companyId,
        status: { in: [JournalStatus.POSTED, JournalStatus.REVERSED] },
      },
    },
    _sum: { debit: true, credit: true },
  });
  const totalDebit = (totals._sum.debit ?? ZERO).toFixed(2);
  const totalCredit = (totals._sum.credit ?? ZERO).toFixed(2);
  console.log('\n  Total posted debit:  ' + totalDebit);
  console.log('  Total posted credit: ' + totalCredit);
  check('Total debit equals total credit across every posted line', totalDebit === totalCredit, {
    totalDebit,
    totalCredit,
  });

  /* ------------------------------------------------ 14. accounting status ---- */

  section('14. Accounting status on the business documents');

  // The integration this whole module exists for: a document that has been
  // finalised should already carry its accounting, raised by the transaction that
  // created it rather than by a separate posting run. Anything PENDING here means
  // a business event slipped through without reaching the books.
  const statuses = await prisma.document.findMany({
    where: { companyId, status: { not: 'CANCELLED' } },
    orderBy: { documentNumber: 'asc' },
    select: {
      documentNumber: true,
      documentType: true,
      accountingStatus: true,
      accountingMessage: true,
    },
  });

  for (const row of statuses) {
    console.log(
      '  ' + row.documentNumber.padEnd(12) + row.documentType.padEnd(20) + row.accountingStatus
    );
  }

  const pending = statuses.filter(
    (d) => d.accountingStatus === 'PENDING' || d.accountingStatus === 'FAILED'
  );
  check(
    'No document is waiting for accounting',
    pending.length === 0,
    pending.map((d) => d.documentNumber + ': ' + d.accountingStatus + ' - ' + d.accountingMessage)
  );

  const byNumber = new Map(statuses.map((d) => [d.documentNumber, d.accountingStatus]));
  equals('INV-0001 accounting status', byNumber.get('INV-0001'), 'POSTED');
  equals('DSP-0001 accounting status', byNumber.get('DSP-0001'), 'POSTED');
  // The credit note clears value the invoice journal never booked as a liability.
  // SKIPPED says so; it is an answer, not a gap.
  equals('CN-0001 accounting status', byNumber.get('CN-0001'), 'SKIPPED');
  equals('TRF-0001 accounting status', byNumber.get('TRF-0001'), 'NOT_REQUIRED');
  equals('PO-0001 accounting status', byNumber.get('PO-0001'), 'NOT_REQUIRED');
  equals('GRN-0001 accounting status', byNumber.get('GRN-0001'), 'NOT_REQUIRED');

  const paidPayment = await prisma.payment.findFirst({
    where: { companyId, supplierId: { not: null } },
    select: { paymentNumber: true, accountingStatus: true },
  });
  equals('Supplier payment accounting status', paidPayment?.accountingStatus, 'POSTED');

  /* -------------------------------------------------- 15. mapping health ---- */

  section('15. Mapping health');

  const health = await getMappingHealth(companyId);
  for (const row of health.rows) {
    console.log(
      '  ' +
        row.mappingType.padEnd(14) +
        (row.resolved ? row.resolved.ledgerCode + '  ' + row.resolved.ledgerName : '-').padEnd(36) +
        row.status
    );
  }
  check('Accounting is initialised', health.initialized);
  check('Every required posting role resolves', health.postable, {
    failing: health.rows.filter((r) => r.required && r.status !== 'PASS'),
  });

  /* ------------------------------------------------- 16. supplier ledger ---- */

  section('16. Supplier subledger against the payables control account');

  const supplierLedger = await getSupplierLedger(accountant, {});
  console.log(
    '  Control account: ' +
      supplierLedger.controlAccount.code +
      ' ' +
      supplierLedger.controlAccount.name
  );
  for (const row of supplierLedger.rows) {
    console.log(
      '  ' +
        row.date.toISOString().slice(0, 10) +
        '  ' +
        (row.document ?? '-').padEnd(12) +
        (row.supplier?.name ?? '-').padEnd(34) +
        row.debit.padStart(12) +
        row.credit.padStart(12) +
        row.runningBalance.padStart(14)
    );
  }

  // Every line on the control account belongs to a supplier. A payable line
  // without one would be invisible to the subledger and would break the
  // reconciliation below without appearing anywhere as a problem.
  const controlLines = await prisma.journalLine.count({
    where: { journalEntry: { companyId }, ledgerId: supplierLedger.controlAccount.ledgerId },
  });
  const controlLinesWithSupplier = await prisma.journalLine.count({
    where: {
      journalEntry: { companyId },
      ledgerId: supplierLedger.controlAccount.ledgerId,
      supplierId: { not: null },
    },
  });
  check(
    'Every payable line names its supplier',
    controlLines === controlLinesWithSupplier && controlLines > 0,
    { controlLines, controlLinesWithSupplier }
  );

  const outstanding = await getSupplierOutstanding(accountant);
  console.log('');
  for (const row of outstanding.rows) {
    console.log(
      '  ' +
        row.supplier.name.padEnd(36) +
        'invoiced ' +
        row.invoiced.padStart(12) +
        '  credited ' +
        row.credited.padStart(10) +
        '  paid ' +
        row.paid.padStart(12) +
        '  outstanding ' +
        row.outstanding.padStart(10) +
        '  ledger ' +
        row.ledgerBalance.padStart(10)
    );
  }

  // The property the subledger is built to have: the sum of the supplier balances
  // IS the control account balance, because they are the same journal lines read
  // two ways rather than two independently maintained figures.
  const controlBalance = await prisma.journalLine.aggregate({
    where: {
      journalEntry: { companyId, status: { in: [JournalStatus.POSTED, JournalStatus.REVERSED] } },
      ledgerId: supplierLedger.controlAccount.ledgerId,
    },
    _sum: { debit: true, credit: true },
  });
  const controlOwed = (controlBalance._sum.credit ?? ZERO)
    .minus(controlBalance._sum.debit ?? ZERO)
    .toFixed(2);
  equals(
    'Supplier subledger closing balance equals the control account',
    supplierLedger.closingBalance,
    controlOwed
  );
  equals('Sum of supplier ledger balances equals the control account', outstanding.totals.ledgerBalance, controlOwed);

  // The documented position and the posted position agree for the scenario, with
  // the one honest exception the invoice policy creates: the credit note cleared
  // 15,750 of disputed value the invoice journal never booked, so the documents
  // show that much less owed than the ledger ever recognised.
  const medisupply = outstanding.rows[0];
  if (medisupply) {
    console.log(
      '\n  Documented outstanding ' +
        medisupply.outstanding +
        ' against ledger balance ' +
        medisupply.ledgerBalance +
        ' (difference ' +
        medisupply.difference +
        ', disputed ' +
        medisupply.disputed +
        ')'
    );
    check(
      'Any difference between the documents and the ledger is the unbooked dispute',
      medisupply.difference === '0.00' ||
        medisupply.difference === '-' + medisupply.disputed ||
        medisupply.difference === medisupply.disputed,
      { difference: medisupply.difference, disputed: medisupply.disputed }
    );
  }

  /* ------------------------------------- 17. cross-tenant subledger access ---- */

  section('17. The subledger is scoped to its own tenant');

  const otherTenantSupplier = await prisma.supplier.findFirst({
    where: { company: { code: ISOLATION_COMPANY_CODE } },
    select: { id: true, name: true },
  });
  if (otherTenantSupplier) {
    let refused = false;
    try {
      await getSupplierLedger(accountant, { supplierId: otherTenantSupplier.id });
    } catch {
      refused = true;
    }
    check("Company A cannot read company B's supplier ledger", refused);
  }

  const companyBOutstanding = await getSupplierOutstanding(await actingAs('admin@othercare.ai'));
  check(
    "Company B's outstanding report shows none of company A's suppliers",
    companyBOutstanding.rows.every((r) => r.supplier.name !== 'MediSupply Pharmaceuticals Pvt. Ltd.'),
    companyBOutstanding.rows.map((r) => r.supplier.name)
  );

  /* ----------------------------------------------------------------- done ---- */

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  console.log(checks - failures + '/' + checks + ' passed');
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Accounting verification failed to run:', error);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
