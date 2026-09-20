/**
 * Asserts that the seeded HealthPilot demo scenario is exactly what it claims
 * to be, and that the demo tenant's books are internally consistent.
 *
 * It reads the database directly and needs no running server: every stock figure
 * is summed from InventoryTransaction, every money figure is read from the
 * documents the services wrote, and every link in the chain is read from
 * DocumentLink. Nothing here recomputes a business rule - it checks the result
 * the application produced against the scenario the assignment specifies, so a
 * regression in the rules shows up as a failed assertion rather than as a seed
 * that quietly writes different numbers.
 *
 *   npm run verify:scenario
 *
 * Exits non-zero on the first failure count, so CI can gate on it.
 */
import {
  DocumentLinkType,
  DocumentStatus,
  DocumentType,
  InventoryTransactionType,
  Prisma,
  StockStatus,
} from '@prisma/client';
import { prisma, disconnectDatabase } from '../database/prisma';

const DEMO_COMPANY_CODE = 'COMP-HEALTHPILOT';
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

async function main() {
  console.log('--- HealthPilot scenario verification ---');

  const company = await prisma.company.findUnique({
    where: { code: DEMO_COMPANY_CODE },
    select: { id: true, name: true },
  });
  if (!company) {
    throw new Error('Demo company ' + DEMO_COMPANY_CODE + ' not found. Run `npm run prisma:seed`.');
  }
  const companyId = company.id;

  const branches = await prisma.branch.findMany({
    where: { companyId },
    select: { id: true, code: true, name: true },
  });
  const branchByCode = new Map(branches.map((branch) => [branch.code, branch]));
  const branchNameById = new Map(branches.map((branch) => [branch.id, branch.code]));

  const documents = await prisma.document.findMany({
    where: { companyId },
    include: { lineItems: { orderBy: { lineNumber: 'asc' } } },
  });
  const byNumber = new Map(documents.map((doc) => [doc.documentNumber, doc]));

  const movements = await prisma.inventoryTransaction.findMany({
    where: { companyId },
    select: {
      id: true,
      branchId: true,
      productId: true,
      batchId: true,
      documentId: true,
      documentLineItemId: true,
      transactionType: true,
      stockStatus: true,
      quantity: true,
      totalCost: true,
      transactionDate: true,
    },
  });

  /* ----------------------------------------------------- stock positions -- */

  section('Stock positions (summed from the InventoryTransaction ledger)');

  const balance = (branchCode: string, status: StockStatus): Prisma.Decimal => {
    const branchId = branchByCode.get(branchCode)?.id;
    return movements
      .filter((m) => m.branchId === branchId && m.stockStatus === status)
      .reduce<Prisma.Decimal>((acc, m) => acc.plus(m.quantity), ZERO);
  };

  equals('Central Warehouse usable', balance('BR-CENTRAL', StockStatus.USABLE).toFixed(2), '40.00');
  equals('Central Warehouse damaged', balance('BR-CENTRAL', StockStatus.DAMAGED).toFixed(2), '20.00');
  equals('Branch A usable', balance('BR-A', StockStatus.USABLE).toFixed(2), '25.00');
  equals('Branch B usable', balance('BR-B', StockStatus.USABLE).toFixed(2), '0.00');
  equals('Branch C usable', balance('BR-C', StockStatus.USABLE).toFixed(2), '0.00');

  const dispensed = movements
    .filter((m) => m.transactionType === InventoryTransactionType.DISPENSING)
    .reduce<Prisma.Decimal>((acc, m) => acc.plus(m.quantity.abs()), ZERO);
  equals('Dispensed', dispensed.toFixed(2), '5.00');

  // Missing quantities never enter the warehouse, so they exist only on the
  // documents: the receipt correction is where the 10 are recorded.
  const missing = documents
    .flatMap((doc) =>
      doc.documentType === DocumentType.GOODS_RECEIPT ||
      doc.documentType === DocumentType.RECEIPT_CORRECTION
        ? doc.lineItems
        : []
    )
    .reduce<Prisma.Decimal>((acc, line) => acc.plus(line.missingQuantity ?? ZERO), ZERO);
  equals('Missing (never delivered)', missing.toFixed(2), '10.00');

  const purchaseOrder = byNumber.get('PO-0001');
  const ordered = (purchaseOrder?.lineItems ?? []).reduce<Prisma.Decimal>(
    (acc, line) => acc.plus(line.quantity),
    ZERO
  );
  equals('Total ordered', ordered.toFixed(2), '100.00');

  // The identity the whole scenario has to satisfy.
  const reconciled = balance('BR-CENTRAL', StockStatus.USABLE)
    .plus(balance('BR-CENTRAL', StockStatus.DAMAGED))
    .plus(balance('BR-A', StockStatus.USABLE))
    .plus(dispensed)
    .plus(missing);
  equals('Reconciliation: 40 + 20 + 25 + 5 + 10', reconciled.toFixed(2), '100.00');

  /* ---------------------------------------------------------------- money -- */

  section('Money');

  equals('PO-0001 subtotal', purchaseOrder?.subtotal.toFixed(2), '50000.00');
  equals('PO-0001 tax', purchaseOrder?.taxAmount.toFixed(2), '2500.00');
  equals('PO-0001 total', purchaseOrder?.totalAmount.toFixed(2), '52500.00');

  const invoice = byNumber.get('INV-0001');
  equals('INV-0001 total', invoice?.totalAmount.toFixed(2), '52500.00');
  equals('INV-0001 disputed', invoice?.disputedAmount.toFixed(2), '15750.00');
  equals(
    'INV-0001 accepted payable',
    invoice ? invoice.totalAmount.minus(invoice.disputedAmount).toFixed(2) : undefined,
    '36750.00'
  );
  equals('INV-0001 paid', invoice?.paidAmount.toFixed(2), '36750.00');
  check('INV-0001 is PAID', invoice?.status === DocumentStatus.PAID, { status: invoice?.status });

  const creditNote = byNumber.get('CN-0001');
  equals('CN-0001 total', creditNote?.totalAmount.toFixed(2), '15750.00');

  const dispensing = byNumber.get('DSP-0001');
  equals('DSP-0001 subtotal', dispensing?.subtotal.toFixed(2), '3250.00');
  equals('DSP-0001 tax', dispensing?.taxAmount.toFixed(2), '162.50');
  equals('DSP-0001 total', dispensing?.totalAmount.toFixed(2), '3412.50');

  const cogs = movements
    .filter(
      (m) =>
        m.transactionType === InventoryTransactionType.DISPENSING &&
        m.documentId === dispensing?.id
    )
    .reduce<Prisma.Decimal>((acc, m) => acc.plus(m.totalCost.abs()), ZERO);
  equals('DSP-0001 COGS', cogs.toFixed(2), '2500.00');

  const payments = await prisma.payment.findMany({
    where: { companyId },
    orderBy: { paymentNumber: 'asc' },
    include: { allocations: { select: { documentId: true, allocatedAmount: true } } },
  });
  const supplierPayment = payments.find((p) => p.paymentNumber === 'PAY-0001');
  const salePayment = payments.find((p) => p.paymentNumber === 'PAY-0002');
  equals('PAY-0001 (supplier) amount', supplierPayment?.amount.toFixed(2), '36750.00');
  equals('PAY-0002 (patient) amount', salePayment?.amount.toFixed(2), '3412.50');
  check('PAY-0002 method is CARD', salePayment?.method === 'CARD', { method: salePayment?.method });

  /* -------------------------------------------- branch-aware fulfilment --- */

  section('Branch-aware fulfilment (P0-4)');

  const requirementA = byNumber.get('REQ-0001');
  const requested = (requirementA?.lineItems ?? []).reduce<Prisma.Decimal>(
    (acc, line) => acc.plus(line.quantity),
    ZERO
  );
  equals('REQ-0001 requested', requested.toFixed(2), '100.00');

  // Fulfilment is usable stock that actually arrived AT Branch A: the transfer
  // receipt, and nothing that is still sitting in the central warehouse.
  const branchAId = branchByCode.get('BR-A')?.id;
  const fulfilled = movements
    .filter(
      (m) =>
        m.branchId === branchAId &&
        m.stockStatus === StockStatus.USABLE &&
        m.transactionType === InventoryTransactionType.TRANSFER_IN
    )
    .reduce<Prisma.Decimal>((acc, m) => acc.plus(m.quantity), ZERO);
  equals('REQ-0001 fulfilled at Branch A', fulfilled.toFixed(2), '30.00');
  equals('REQ-0001 remaining', requested.minus(fulfilled).toFixed(2), '70.00');
  check(
    'REQ-0001 is PARTIALLY_FULFILLED',
    requirementA?.status === DocumentStatus.PARTIALLY_FULFILLED,
    { status: requirementA?.status }
  );

  const centralUsableFromReceipts = movements
    .filter(
      (m) =>
        m.branchId === branchByCode.get('BR-CENTRAL')?.id &&
        m.stockStatus === StockStatus.USABLE &&
        (m.transactionType === InventoryTransactionType.RECEIPT ||
          m.transactionType === InventoryTransactionType.CORRECTION)
    )
    .reduce<Prisma.Decimal>((acc, m) => acc.plus(m.quantity), ZERO);
  check(
    'The 70 accepted at Central do NOT count towards REQ-0001',
    centralUsableFromReceipts.toFixed(2) === '70.00' && fulfilled.toFixed(2) === '30.00',
    { centralAccepted: centralUsableFromReceipts.toFixed(2), branchAFulfilled: fulfilled.toFixed(2) }
  );

  const requirementB = byNumber.get('REQ-0002');
  const requirementC = byNumber.get('REQ-0003');
  check('REQ-0002 (Branch B, 40) is APPROVED and unfulfilled', requirementB?.status === DocumentStatus.APPROVED, {
    status: requirementB?.status,
  });
  check('REQ-0003 (Branch C, 60) is APPROVED and unfulfilled', requirementC?.status === DocumentStatus.APPROVED, {
    status: requirementC?.status,
  });

  /* ------------------------------------------------------ document chain -- */

  section('Document chain');

  const links = await prisma.documentLink.findMany({
    where: { companyId },
    select: { sourceDocumentId: true, targetDocumentId: true, linkType: true },
  });
  const numberById = new Map(documents.map((doc) => [doc.id, doc.documentNumber]));
  const linkSet = new Set(
    links.map(
      (link) =>
        numberById.get(link.sourceDocumentId) +
        '->' +
        numberById.get(link.targetDocumentId) +
        ':' +
        link.linkType
    )
  );

  const expectedLinks: [string, string, DocumentLinkType][] = [
    ['PO-0001', 'REQ-0001', DocumentLinkType.FULFILLS],
    ['GRN-0001', 'PO-0001', DocumentLinkType.RECEIVED_AGAINST],
    ['COR-0001', 'GRN-0001', DocumentLinkType.CORRECTS],
    ['INV-0001', 'PO-0001', DocumentLinkType.INVOICED_AGAINST],
    ['CN-0001', 'INV-0001', DocumentLinkType.CREDIT_FOR],
    ['TRF-0001', 'REQ-0001', DocumentLinkType.TRANSFER_FOR],
  ];
  for (const [source, target, type] of expectedLinks) {
    check(
      source + ' -> ' + target + ' (' + type + ')',
      linkSet.has(source + '->' + target + ':' + type)
    );
  }

  check(
    'No duplicate document links',
    linkSet.size === links.length,
    { unique: linkSet.size, total: links.length }
  );

  // The two ends of the chain that are movements and money rather than links.
  const transfer = byNumber.get('TRF-0001');
  const transferIn = movements.filter(
    (m) => m.documentId === transfer?.id && m.transactionType === InventoryTransactionType.TRANSFER_IN
  );
  check(
    'TRF-0001 -> Branch A receipt (TRANSFER_IN at Branch A)',
    transferIn.length === 1 && transferIn[0].branchId === branchAId,
    { rows: transferIn.length, branch: transferIn[0] && branchNameById.get(transferIn[0].branchId) }
  );
  check('TRF-0001 is RECEIVED', transfer?.status === DocumentStatus.RECEIVED, {
    status: transfer?.status,
  });

  const dispensedFromTransferredBatch = movements.some(
    (m) =>
      m.documentId === dispensing?.id &&
      transferIn.some((t) => t.batchId === m.batchId && t.branchId === m.branchId)
  );
  check('TRF-0001 batch at Branch A -> DSP-0001', dispensedFromTransferredBatch);

  check(
    'DSP-0001 -> PAY-0002 allocation',
    Boolean(
      salePayment &&
        dispensing &&
        salePayment.allocations.some(
          (a) => a.documentId === dispensing.id && a.allocatedAmount.toFixed(2) === '3412.50'
        )
    )
  );
  check(
    'INV-0001 -> PAY-0001 allocation',
    Boolean(
      supplierPayment &&
        invoice &&
        supplierPayment.allocations.some(
          (a) => a.documentId === invoice.id && a.allocatedAmount.toFixed(2) === '36750.00'
        )
    )
  );

  /* -------------------------------------------------------- data hygiene -- */

  section('Ledger and document integrity');

  const expectedDocuments = [
    'REQ-0001',
    'REQ-0002',
    'REQ-0003',
    'PO-0001',
    'GRN-0001',
    'COR-0001',
    'INV-0001',
    'CN-0001',
    'TRF-0001',
    'DSP-0001',
  ];
  for (const number of expectedDocuments) {
    check('Document ' + number + ' exists', byNumber.has(number));
  }
  check(
    'No extra documents in the demo tenant',
    documents.length === expectedDocuments.length,
    { actual: documents.map((d) => d.documentNumber).sort(), expected: expectedDocuments }
  );
  check('No TRF-0002 / TRF-0003 exploratory transfers', !byNumber.has('TRF-0002') && !byNumber.has('TRF-0003'));

  check(
    'No duplicate document numbers',
    new Set(documents.map((d) => d.documentNumber)).size === documents.length
  );
  check(
    'No duplicate payment numbers',
    new Set(payments.map((p) => p.paymentNumber)).size === payments.length
  );

  // Negative stock, per bucket, from the ledger itself.
  const bucketTotals = new Map<string, Prisma.Decimal>();
  for (const movement of movements) {
    const key = [movement.branchId, movement.productId, movement.batchId, movement.stockStatus].join(':');
    bucketTotals.set(key, (bucketTotals.get(key) ?? ZERO).plus(movement.quantity));
  }
  const negative = [...bucketTotals.entries()].filter(([, qty]) => qty.lessThan(0));
  check('Zero negative stock buckets', negative.length === 0, negative.map(([k, v]) => k + '=' + v.toFixed(2)));

  const orphans = movements.filter((m) => !m.documentId);
  check('No orphan inventory movements (every row cites a document)', orphans.length === 0, {
    orphans: orphans.length,
  });

  const unknownDocument = movements.filter((m) => m.documentId && !numberById.has(m.documentId));
  check('No movements citing a document outside the tenant', unknownDocument.length === 0);

  // A movement must sit at a branch the document it cites actually involves.
  const documentById = new Map(documents.map((doc) => [doc.id, doc]));
  const crossBranch = movements.filter((movement) => {
    const doc = movement.documentId ? documentById.get(movement.documentId) : undefined;
    if (!doc) {
      return false;
    }
    const allowed = [doc.branchId, doc.sourceBranchId, doc.destinationBranchId].filter(Boolean);
    return !allowed.includes(movement.branchId);
  });
  check('No invalid cross-branch movements', crossBranch.length === 0, {
    rows: crossBranch.map((m) => m.id),
  });

  // One movement per (document line, type, status): a replayed posting would
  // show up here as a second identical row.
  const movementKeys = movements.map((m) =>
    [m.documentLineItemId, m.transactionType, m.stockStatus, m.branchId].join(':')
  );
  check(
    'No duplicate ledger movements',
    new Set(movementKeys).size === movementKeys.length,
    { unique: new Set(movementKeys).size, total: movementKeys.length }
  );

  const batches = await prisma.batch.findMany({
    where: { companyId },
    select: { id: true, batchNumber: true, expiryDate: true, status: true },
  });
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));
  const badTransfers = movements.filter((movement) => {
    if (
      movement.transactionType !== InventoryTransactionType.TRANSFER_OUT &&
      movement.transactionType !== InventoryTransactionType.TRANSFER_IN
    ) {
      return false;
    }
    const batch = batchById.get(movement.batchId);
    if (!batch) {
      return true;
    }
    return batch.status !== StockStatus.USABLE || batch.expiryDate <= movement.transactionDate;
  });
  check('No expired or non-usable stock transferred', badTransfers.length === 0, {
    rows: badTransfers.map((m) => m.id),
  });

  const nonUsableTransferBuckets = movements.filter(
    (m) =>
      (m.transactionType === InventoryTransactionType.TRANSFER_OUT ||
        m.transactionType === InventoryTransactionType.TRANSFER_IN) &&
      m.stockStatus !== StockStatus.USABLE
  );
  check('Transfers only ever move the USABLE bucket', nonUsableTransferBuckets.length === 0);

  /* ------------------------------------------------------ business dates -- */

  section('Business dates');

  const expectedDates: [string, string][] = [
    ['REQ-0001', '2026-09-01'],
    ['REQ-0002', '2026-09-01'],
    ['REQ-0003', '2026-09-01'],
    ['PO-0001', '2026-09-02'],
    ['GRN-0001', '2026-09-05'],
    ['COR-0001', '2026-09-06'],
    ['INV-0001', '2026-09-06'],
    ['CN-0001', '2026-09-06'],
    ['TRF-0001', '2026-09-09'],
    ['DSP-0001', '2026-09-09'],
  ];
  for (const [number, day] of expectedDates) {
    const doc = byNumber.get(number);
    check(
      number + ' dated ' + day,
      doc?.documentDate.toISOString().slice(0, 10) === day,
      { actual: doc?.documentDate.toISOString().slice(0, 10) }
    );
  }

  /* ------------------------------------------------------ tenant isolation -- */

  section('Tenant isolation');

  const otherTenants = await prisma.company.findMany({
    where: { code: { notIn: [DEMO_COMPANY_CODE] } },
    select: { code: true, _count: { select: { documents: true, branches: true, users: true } } },
  });
  console.log(
    'INFO other tenants untouched by the seed: ' +
      JSON.stringify(otherTenants.map((t) => t.code + ' (' + t._count.branches + ' branches)'))
  );

  const strayMovements = await prisma.inventoryTransaction.count({
    where: { companyId, branch: { companyId: { not: companyId } } },
  });
  check('Every movement belongs to a branch of its own company', strayMovements === 0);

  /* ---------------------------------------------------------------- done -- */

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  console.log(checks - failures + '/' + checks + ' passed');
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('Scenario verification failed to run:', error);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);
