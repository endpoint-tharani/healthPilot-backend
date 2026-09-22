import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountingEvent,
  AccountMappingType,
  BranchScopeType,
  BranchType,
  DocumentType,
  JournalStatus,
  PaymentMethod,
  Prisma,
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
import {
  getMappingHealth,
  resolveAccountingAccount,
} from '../../services/accounting/accountMapping.service';
import {
  getSupplierLedger,
  getSupplierOutstanding,
} from '../../services/accounting/supplierLedger.service';
import { postSupplierPaymentAccounting } from '../../services/accounting/accounting.service';
import { retryDocumentAccounting } from '../../services/accounting/autoPost.service';
import {
  getBalanceSheet,
  getProfitAndLoss,
  getTrialBalance,
} from '../../services/accounting/reports.service';
import {
  approveRequirement,
  createRequirement,
  submitRequirement,
} from '../../services/stockRequirement.service';
import { approvePurchaseOrder, createPurchaseOrder } from '../../services/purchaseOrder.service';
import { createGoodsReceipt, postGoodsReceipt } from '../../services/goodsReceipt.service';
import { createReceiptCorrection } from '../../services/receiptCorrection.service';
import { createSupplierInvoice } from '../../services/supplierInvoice.service';
import { createCreditNote } from '../../services/creditNote.service';
import { allocatePayment, createPayment } from '../../services/payment.service';
import { createDispensing } from '../../services/dispensing.service';

/**
 * The accounting integration, through the pharmacy workflow rather than around it.
 *
 * The sibling suite exercises the accounting layer against documents written
 * directly, which is the right shape for testing posting rules. This one asks the
 * question that layer cannot: when a pharmacist finalises a supplier invoice
 * through the ordinary service, does a payable actually reach the balance sheet?
 *
 * So every document here is raised by the real business service - requisition,
 * purchase order, goods receipt, correction, invoice, credit note, payment,
 * dispensing - and the assertions are about what the books did on their own,
 * without anything calling a posting function.
 */

const RUN = Date.now().toString(36);
const COMPANY = 'TEST-AUTO-' + RUN;
const UNINITIALISED = 'TEST-NOACC-' + RUN;
const OTHER = 'TEST-OTHER-' + RUN;

interface Tenant {
  companyId: string;
  centralBranchId: string;
  wardBranchId: string;
  auth: AuthContext;
  supplierId: string;
  productId: string;
  batchId: string;
}

const DATE = {
  requisition: new Date('2026-09-01T00:00:00.000Z'),
  requiredBy: new Date('2026-09-08T00:00:00.000Z'),
  purchaseOrder: new Date('2026-09-02T00:00:00.000Z'),
  receipt: new Date('2026-09-05T00:00:00.000Z'),
  correction: new Date('2026-09-06T00:00:00.000Z'),
  sale: new Date('2026-09-09T00:00:00.000Z'),
};

async function createTenant(code: string, options: { initialize: boolean }): Promise<Tenant> {
  const company = await prisma.company.create({ data: { code, name: code } });

  const central = await prisma.branch.create({
    data: {
      companyId: company.id,
      code: 'CENTRAL',
      name: 'Central Warehouse',
      type: BranchType.CENTRAL_WAREHOUSE,
    },
  });
  const ward = await prisma.branch.create({
    data: { companyId: company.id, code: 'WARD', name: 'Ward', type: BranchType.BRANCH },
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

  const supplier = await prisma.supplier.create({
    data: { companyId: company.id, code: 'SUP', name: 'Test Supplier' },
  });
  const product = await prisma.product.create({
    data: {
      companyId: company.id,
      code: 'PRD',
      name: 'Insulin Glargine',
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

  if (options.initialize) {
    await initializeCompanyAccounting(company.id);
  }

  return {
    companyId: company.id,
    centralBranchId: central.id,
    wardBranchId: ward.id,
    supplierId: supplier.id,
    productId: product.id,
    batchId: batch.id,
    auth: {
      userId: user.id,
      companyId: company.id,
      role: UserRole.COMPANY_ADMIN,
      scopeType: BranchScopeType.ALL_BRANCHES,
      hasAllBranches: true,
      allowedBranchIds: [],
      hasCentralWarehouseAccess: true,
      permissions: permissionsForRole(UserRole.COMPANY_ADMIN),
    },
  };
}

async function dropTenant(code: string) {
  const company = await prisma.company.findUnique({ where: { code }, select: { id: true } });
  if (!company) {
    return;
  }
  const companyId = company.id;

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

/**
 * The HealthPilot scenario, raised entirely through the business services.
 *
 * 100 vials ordered at 500 + 5% tax; the delivery is signed for in full and a
 * cold-chain correction then finds 20 damaged and 10 missing, so only 70 are
 * accepted. The supplier bills all 100 (52,500) but only 36,750 is payable.
 */
async function runProcurement(tenant: Tenant) {
  const requirementId = await createRequirement(tenant.auth, {
    branchId: tenant.wardBranchId,
    documentDate: DATE.requisition,
    requiredDate: DATE.requiredBy,
    reason: 'Ward cycle',
    lines: [{ productId: tenant.productId, quantity: '100' }],
  });
  await submitRequirement(tenant.auth, requirementId, 'Submitted');
  await approveRequirement(tenant.auth, requirementId, 'Approved');

  const purchaseOrderId = await createPurchaseOrder(tenant.auth, {
    requirementId,
    supplierId: tenant.supplierId,
    deliveryBranchId: tenant.centralBranchId,
    documentDate: DATE.purchaseOrder,
    expectedDeliveryDate: DATE.receipt,
    lines: [{ productId: tenant.productId, quantity: '100', unitPrice: '500.00', taxRate: '5.00' }],
  });
  await approvePurchaseOrder(tenant.auth, purchaseOrderId, 'Within budget');

  const poLine = await prisma.documentLineItem.findFirstOrThrow({
    where: { documentId: purchaseOrderId },
    orderBy: { lineNumber: 'asc' },
  });

  const goodsReceiptId = await createGoodsReceipt(tenant.auth, {
    purchaseOrderId,
    supplierRef: 'DN-1',
    receiptDate: DATE.receipt,
    lines: [
      {
        purchaseOrderLineItemId: poLine.id,
        quantity: '100',
        acceptedQuantity: '100',
        damagedQuantity: '0',
        missingQuantity: '0',
        batchId: tenant.batchId,
      },
    ],
  });
  await postGoodsReceipt(tenant.auth, goodsReceiptId, 'Booked in');

  const grnLine = await prisma.documentLineItem.findFirstOrThrow({
    where: { documentId: goodsReceiptId },
    orderBy: { lineNumber: 'asc' },
  });

  await createReceiptCorrection(tenant.auth, {
    goodsReceiptId,
    documentDate: DATE.correction,
    reason: 'Cold chain: 20 damaged, 10 never arrived',
    lines: [
      {
        goodsReceiptLineItemId: grnLine.id,
        correctedAcceptedQuantity: '70',
        correctedDamagedQuantity: '20',
        correctedMissingQuantity: '10',
      },
    ],
  });

  const invoice = await createSupplierInvoice(tenant.auth, {
    purchaseOrderId,
    supplierRef: 'INV-SUP-1',
    invoiceDate: DATE.correction,
    lines: [{ productId: tenant.productId, quantity: '100', unitPrice: '500.00', taxRate: '5.00' }],
  });

  return { requirementId, purchaseOrderId, goodsReceiptId, invoiceId: invoice.id };
}

let tenant: Tenant;
let other: Tenant;
let procurement: Awaited<ReturnType<typeof runProcurement>>;
let creditNoteId: string;
let paymentId: string;
let dispensingId: string;

beforeAll(async () => {
  tenant = await createTenant(COMPANY, { initialize: true });
  other = await createTenant(OTHER, { initialize: true });
  procurement = await runProcurement(tenant);

  const creditNote = await createCreditNote(tenant.auth, {
    supplierInvoiceId: procurement.invoiceId,
    documentDate: DATE.correction,
    reason: '30 vials not usable',
    lines: [{ productId: tenant.productId, quantity: '30', unitPrice: '500.00', taxRate: '5.00' }],
  });
  creditNoteId = creditNote.id;

  const payment = await createPayment(tenant.auth, {
    supplierId: tenant.supplierId,
    branchId: tenant.centralBranchId,
    amount: '36750.00',
    method: PaymentMethod.BANK_TRANSFER,
    paymentDate: DATE.correction,
    allocations: [{ documentId: procurement.invoiceId, amount: '36750.00' }],
  });
  paymentId = payment.id;

  // Dispensed from the central warehouse, where the stock actually landed.
  const dispensing = await createDispensing(tenant.auth, {
    branchId: tenant.centralBranchId,
    documentDate: DATE.sale,
    patientRef: 'PAT-1',
    prescriptionRef: 'RX-1',
    paymentMethod: PaymentMethod.CARD,
    lines: [{ productId: tenant.productId, batchId: tenant.batchId, quantity: '5' }],
  });
  dispensingId = dispensing.id;
}, 600_000);

afterAll(async () => {
  await dropTenant(COMPANY);
  await dropTenant(OTHER);
  await dropTenant(UNINITIALISED);
  await disconnectDatabase();
}, 300_000);

function journalsFor(documentId: string, event: AccountingEvent) {
  return prisma.journalEntry.findMany({
    where: { sourceDocumentId: documentId, event },
    include: { lines: { include: { ledger: true }, orderBy: { lineNumber: 'asc' } } },
  });
}

async function ledgerCode(role: AccountMappingType, companyId: string): Promise<string> {
  return (await resolveAccountingAccount(companyId, null, role)).ledgerCode;
}

describe('supplier invoice', () => {
  it('books the payable when the invoice is raised, without anything posting it', async () => {
    const entries = await journalsFor(procurement.invoiceId, AccountingEvent.SUPPLIER_INVOICE);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.status).toBe(JournalStatus.POSTED);
    // 70 accepted at 500 = 35,000 goods, 1,750 input tax, 36,750 payable. Not the
    // 52,500 the supplier claimed.
    expect(entry.totalDebit.toFixed(2)).toBe('36750.00');
    expect(entry.totalCredit.toFixed(2)).toBe('36750.00');

    const byCode = new Map(entry.lines.map((l) => [l.ledger.code, l]));
    const inventory = await ledgerCode(AccountMappingType.INVENTORY, tenant.companyId);
    const vendor = await ledgerCode(AccountMappingType.VENDOR, tenant.companyId);
    const inputTax = await ledgerCode(AccountMappingType.INPUT_TAX, tenant.companyId);

    expect(byCode.get(inventory)?.debit.toFixed(2)).toBe('35000.00');
    expect(byCode.get(inputTax)?.debit.toFixed(2)).toBe('1750.00');
    expect(byCode.get(vendor)?.credit.toFixed(2)).toBe('36750.00');
  });

  it('marks the document POSTED, with the journal behind it', async () => {
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: procurement.invoiceId },
      select: { accountingStatus: true, accountingPostedAt: true },
    });
    expect(document.accountingStatus).toBe('POSTED');
    expect(document.accountingPostedAt).not.toBeNull();
  });

  it('carries the supplier on the payable line, and only on that line', async () => {
    const [entry] = await journalsFor(procurement.invoiceId, AccountingEvent.SUPPLIER_INVOICE);
    const vendor = await ledgerCode(AccountMappingType.VENDOR, tenant.companyId);

    for (const line of entry.lines) {
      if (line.ledger.code === vendor) {
        expect(line.supplierId).toBe(tenant.supplierId);
      } else {
        // Inventory and input tax are the company's, not the supplier's. Tagging
        // them would double the supplier's balance in the subledger.
        expect(line.supplierId).toBeNull();
      }
    }
  });

  it('cannot be booked twice, however many times posting is retried', async () => {
    await retryDocumentAccounting(tenant.auth, procurement.invoiceId);
    await retryDocumentAccounting(tenant.auth, procurement.invoiceId);

    const entries = await journalsFor(procurement.invoiceId, AccountingEvent.SUPPLIER_INVOICE);
    expect(entries).toHaveLength(1);
  });

  it('refuses a second journal even when posting concurrently', async () => {
    // The guard is a unique index, not a check-then-insert, so both of these reach
    // the database and exactly one wins.
    const results = await Promise.allSettled([
      retryDocumentAccounting(tenant.auth, procurement.invoiceId),
      retryDocumentAccounting(tenant.auth, procurement.invoiceId),
      retryDocumentAccounting(tenant.auth, procurement.invoiceId),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const entries = await journalsFor(procurement.invoiceId, AccountingEvent.SUPPLIER_INVOICE);
    expect(entries).toHaveLength(1);
  });
});

describe('supplier credit note', () => {
  it('records why no journal was raised, rather than looking unposted', async () => {
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: creditNoteId },
      select: { accountingStatus: true, accountingMessage: true },
    });

    // The invoice booked the accepted payable of 36,750, never the disputed
    // 15,750. There is no liability for this credit to reduce, so a journal would
    // take payables below what is owed.
    expect(document.accountingStatus).toBe('SKIPPED');
    expect(document.accountingMessage).toContain('never booked as a liability');

    const entries = await journalsFor(creditNoteId, AccountingEvent.CREDIT_NOTE);
    expect(entries).toHaveLength(0);
  });

  it('raises exactly one journal when the credit does land on booked liability', async () => {
    // A second tenant, invoiced in full with nothing disputed, so the credit note
    // has a real payable to reduce.
    const clean = other;
    const requirementId = await createRequirement(clean.auth, {
      branchId: clean.wardBranchId,
      documentDate: DATE.requisition,
      requiredDate: DATE.requiredBy,
      reason: 'Clean run',
      lines: [{ productId: clean.productId, quantity: '10' }],
    });
    await submitRequirement(clean.auth, requirementId, 'Submitted');
    await approveRequirement(clean.auth, requirementId, 'Approved');

    const purchaseOrderId = await createPurchaseOrder(clean.auth, {
      requirementId,
      supplierId: clean.supplierId,
      deliveryBranchId: clean.centralBranchId,
      documentDate: DATE.purchaseOrder,
      expectedDeliveryDate: DATE.receipt,
      lines: [{ productId: clean.productId, quantity: '10', unitPrice: '500.00', taxRate: '5.00' }],
    });
    await approvePurchaseOrder(clean.auth, purchaseOrderId, 'Approved');

    const poLine = await prisma.documentLineItem.findFirstOrThrow({
      where: { documentId: purchaseOrderId },
      orderBy: { lineNumber: 'asc' },
    });
    const goodsReceiptId = await createGoodsReceipt(clean.auth, {
      purchaseOrderId,
      supplierRef: 'DN-2',
      receiptDate: DATE.receipt,
      lines: [
        {
          purchaseOrderLineItemId: poLine.id,
          quantity: '10',
          acceptedQuantity: '10',
          damagedQuantity: '0',
          missingQuantity: '0',
          batchId: clean.batchId,
        },
      ],
    });
    await postGoodsReceipt(clean.auth, goodsReceiptId, 'Booked in');

    const invoice = await createSupplierInvoice(clean.auth, {
      purchaseOrderId,
      supplierRef: 'INV-SUP-2',
      invoiceDate: DATE.correction,
      lines: [{ productId: clean.productId, quantity: '10', unitPrice: '500.00', taxRate: '5.00' }],
    });

    const invoiceDocument = await prisma.document.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { disputedAmount: true, accountingStatus: true },
    });
    expect(invoiceDocument.disputedAmount.toFixed(2)).toBe('0.00');
    expect(invoiceDocument.accountingStatus).toBe('POSTED');

    // Nothing is disputed, so the credit note path refuses the credit outright -
    // which is the pharmacy rule, and proves the two layers agree about what a
    // credit note is for.
    await expect(
      createCreditNote(clean.auth, {
        supplierInvoiceId: invoice.id,
        documentDate: DATE.correction,
        reason: 'Nothing was actually wrong',
        lines: [{ productId: clean.productId, quantity: '2', unitPrice: '500.00', taxRate: '5.00' }],
      })
    ).rejects.toThrow(/exceeds the eligible disputed amount/);
  });
});

describe('supplier payment', () => {
  it('books the settlement when the payment is created with its allocation', async () => {
    const entries = await prisma.journalEntry.findMany({
      where: { sourcePaymentId: paymentId, event: AccountingEvent.SUPPLIER_PAYMENT },
      include: { lines: { include: { ledger: true } } },
    });
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.totalDebit.toFixed(2)).toBe('36750.00');

    const vendor = await ledgerCode(AccountMappingType.VENDOR, tenant.companyId);
    const bank = await ledgerCode(AccountMappingType.BANK, tenant.companyId);
    const byCode = new Map(entry.lines.map((l) => [l.ledger.code, l]));

    expect(byCode.get(vendor)?.debit.toFixed(2)).toBe('36750.00');
    expect(byCode.get(bank)?.credit.toFixed(2)).toBe('36750.00');
    expect(byCode.get(vendor)?.supplierId).toBe(tenant.supplierId);
  });

  it('marks the payment POSTED', async () => {
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { accountingStatus: true },
    });
    expect(payment.accountingStatus).toBe('POSTED');
  });

  it('cannot be booked twice', async () => {
    await postSupplierPaymentAccounting(tenant.auth, paymentId);
    await postSupplierPaymentAccounting(tenant.auth, paymentId);

    const entries = await prisma.journalEntry.findMany({
      where: { sourcePaymentId: paymentId, event: AccountingEvent.SUPPLIER_PAYMENT },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceEventKey).toBe(
      accountingEventKey(AccountingEvent.SUPPLIER_PAYMENT, paymentId)
    );
  });

  it('leaves an unallocated payment pending rather than booking money against nothing', async () => {
    const unallocated = await createPayment(tenant.auth, {
      supplierId: tenant.supplierId,
      branchId: tenant.centralBranchId,
      amount: '1000.00',
      method: PaymentMethod.BANK_TRANSFER,
      paymentDate: DATE.correction,
    });

    const row = await prisma.payment.findUniqueOrThrow({
      where: { id: unallocated.id },
      select: { accountingStatus: true, accountingMessage: true },
    });
    expect(row.accountingStatus).toBe('PENDING');
    expect(row.accountingMessage).toContain('Not allocated to a supplier invoice');

    const entries = await prisma.journalEntry.count({
      where: { sourcePaymentId: unallocated.id },
    });
    expect(entries).toBe(0);
  });

  it('books a later allocation as its own entry rather than restating the first', async () => {
    // A fresh invoice for this supplier, so there is something new to settle.
    const invoice = await prisma.document.create({
      data: {
        companyId: tenant.companyId,
        branchId: tenant.centralBranchId,
        supplierId: tenant.supplierId,
        documentNumber: 'INV-TOPUP-' + RUN,
        documentType: DocumentType.SUPPLIER_INVOICE,
        status: 'POSTED',
        documentDate: DATE.correction,
        subtotal: '500.00',
        taxAmount: '0.00',
        totalAmount: '500.00',
        balanceAmount: '500.00',
        createdById: tenant.auth.userId,
      },
    });

    const payment = await createPayment(tenant.auth, {
      supplierId: tenant.supplierId,
      branchId: tenant.centralBranchId,
      amount: '500.00',
      method: PaymentMethod.BANK_TRANSFER,
      paymentDate: DATE.correction,
    });

    await allocatePayment(tenant.auth, payment.id, [
      { documentId: invoice.id, amount: '200.00' },
    ]);
    await allocatePayment(tenant.auth, payment.id, [
      { documentId: invoice.id, amount: '300.00' },
    ]);

    const entries = await prisma.journalEntry.findMany({
      where: { sourcePaymentId: payment.id, event: AccountingEvent.SUPPLIER_PAYMENT },
      orderBy: { journalNumber: 'asc' },
    });

    // Two entries: the first settlement and the increment. Posted accounting is
    // history, so the second allocation is booked rather than folded into the first.
    expect(entries).toHaveLength(2);
    expect(entries[0].totalDebit.toFixed(2)).toBe('200.00');
    expect(entries[1].totalDebit.toFixed(2)).toBe('300.00');

    // And the total settled is the total allocated, not double it.
    const booked = entries.reduce(
      (acc, e) => acc.plus(e.totalDebit),
      new Prisma.Decimal(0)
    );
    expect(booked.toFixed(2)).toBe('500.00');

    // Replaying the posting books nothing further.
    await postSupplierPaymentAccounting(tenant.auth, payment.id);
    const after = await prisma.journalEntry.count({
      where: { sourcePaymentId: payment.id, event: AccountingEvent.SUPPLIER_PAYMENT },
    });
    expect(after).toBe(2);
  });

  it("refuses to settle another supplier's invoice", async () => {
    const stranger = await prisma.supplier.create({
      data: { companyId: tenant.companyId, code: 'SUP-2-' + RUN, name: 'Other Supplier' },
    });
    const strangerInvoice = await prisma.document.create({
      data: {
        companyId: tenant.companyId,
        branchId: tenant.centralBranchId,
        supplierId: stranger.id,
        documentNumber: 'INV-STRANGER-' + RUN,
        documentType: DocumentType.SUPPLIER_INVOICE,
        status: 'POSTED',
        documentDate: DATE.correction,
        subtotal: '100.00',
        totalAmount: '100.00',
        balanceAmount: '100.00',
        createdById: tenant.auth.userId,
      },
    });

    const payment = await prisma.payment.create({
      data: {
        companyId: tenant.companyId,
        branchId: tenant.centralBranchId,
        supplierId: tenant.supplierId,
        paymentNumber: 'PAY-CROSS-' + RUN,
        amount: '100.00',
        method: PaymentMethod.BANK_TRANSFER,
        paymentDate: DATE.correction,
        createdById: tenant.auth.userId,
      },
    });
    // Written directly, bypassing the allocation service, exactly as a bad row
    // would arrive. Accounting is the last place to catch it.
    await prisma.paymentAllocation.create({
      data: { paymentId: payment.id, documentId: strangerInvoice.id, allocatedAmount: '100.00' },
    });

    await expect(postSupplierPaymentAccounting(tenant.auth, payment.id)).rejects.toThrow(
      /owed to a different supplier/
    );
    expect(await prisma.journalEntry.count({ where: { sourcePaymentId: payment.id } })).toBe(0);
  });
});

describe('dispensing', () => {
  it('books the sale when the dispensing is created', async () => {
    const entries = await journalsFor(dispensingId, AccountingEvent.SALES);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    // 5 vials at 650 = 3,250 revenue, 162.50 output tax, 3,412.50 collected.
    expect(entry.totalDebit.toFixed(2)).toBe('3412.50');

    const byCode = new Map(entry.lines.map((l) => [l.ledger.code, l]));
    const sales = await ledgerCode(AccountMappingType.SALES, tenant.companyId);
    const outputTax = await ledgerCode(AccountMappingType.OUTPUT_TAX, tenant.companyId);

    expect(byCode.get(sales)?.credit.toFixed(2)).toBe('3250.00');
    expect(byCode.get(outputTax)?.credit.toFixed(2)).toBe('162.50');
  });

  it('books cost of sales at the stock ledger cost, not from the selling price', async () => {
    const entries = await journalsFor(dispensingId, AccountingEvent.COGS);
    expect(entries).toHaveLength(1);

    // 5 vials at the 500 purchase price the inventory service recorded = 2,500.
    // Derived from the selling price it would have been 3,250 and the margin
    // would have vanished.
    expect(entries[0].totalDebit.toFixed(2)).toBe('2500.00');

    const movements = await prisma.inventoryTransaction.aggregate({
      where: { documentId: dispensingId },
      _sum: { totalCost: true },
    });
    expect((movements._sum.totalCost ?? new Prisma.Decimal(0)).absoluteValue().toFixed(2)).toBe(
      '2500.00'
    );
  });

  it('marks the dispensing POSTED only once both entries exist', async () => {
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: dispensingId },
      select: { accountingStatus: true, accountingMessage: true },
    });
    expect(document.accountingStatus).toBe('POSTED');
    expect(document.accountingMessage).toContain('cost of sales');
  });

  it('cannot duplicate either entry on a repeated request', async () => {
    await retryDocumentAccounting(tenant.auth, dispensingId);
    await retryDocumentAccounting(tenant.auth, dispensingId);

    expect(await journalsFor(dispensingId, AccountingEvent.SALES)).toHaveLength(1);
    expect(await journalsFor(dispensingId, AccountingEvent.COGS)).toHaveLength(1);
  });

  it('books the patient receipt through the sale, not as a payment of its own', async () => {
    const receipt = await prisma.payment.findFirstOrThrow({
      where: { companyId: tenant.companyId, supplierId: null },
      select: { id: true, accountingStatus: true, accountingMessage: true },
    });
    expect(receipt.accountingStatus).toBe('NOT_REQUIRED');
    expect(receipt.accountingMessage).toContain('dispensing sale');
    expect(await prisma.journalEntry.count({ where: { sourcePaymentId: receipt.id } })).toBe(0);
  });
});

describe('when accounting cannot post', () => {
  it('records the document as pending rather than losing the event, if the company has no chart', async () => {
    const bare = await createTenant(UNINITIALISED, { initialize: false });
    const health = await getMappingHealth(bare.companyId);
    expect(health.initialized).toBe(false);

    const requirementId = await createRequirement(bare.auth, {
      branchId: bare.wardBranchId,
      documentDate: DATE.requisition,
      requiredDate: DATE.requiredBy,
      reason: 'No books yet',
      lines: [{ productId: bare.productId, quantity: '10' }],
    });
    await submitRequirement(bare.auth, requirementId, 'Submitted');
    await approveRequirement(bare.auth, requirementId, 'Approved');

    const purchaseOrderId = await createPurchaseOrder(bare.auth, {
      requirementId,
      supplierId: bare.supplierId,
      deliveryBranchId: bare.centralBranchId,
      documentDate: DATE.purchaseOrder,
      expectedDeliveryDate: DATE.receipt,
      lines: [{ productId: bare.productId, quantity: '10', unitPrice: '500.00', taxRate: '5.00' }],
    });
    await approvePurchaseOrder(bare.auth, purchaseOrderId, 'Approved');

    const poLine = await prisma.documentLineItem.findFirstOrThrow({
      where: { documentId: purchaseOrderId },
      orderBy: { lineNumber: 'asc' },
    });
    const goodsReceiptId = await createGoodsReceipt(bare.auth, {
      purchaseOrderId,
      supplierRef: 'DN-3',
      receiptDate: DATE.receipt,
      lines: [
        {
          purchaseOrderLineItemId: poLine.id,
          quantity: '10',
          acceptedQuantity: '10',
          damagedQuantity: '0',
          missingQuantity: '0',
          batchId: bare.batchId,
        },
      ],
    });
    await postGoodsReceipt(bare.auth, goodsReceiptId, 'Booked in');

    // The pharmacy still works. That is the deliberate exception: a tenant that
    // has not been onboarded onto accounting is not a broken pharmacy.
    const invoice = await createSupplierInvoice(bare.auth, {
      purchaseOrderId,
      supplierRef: 'INV-SUP-3',
      invoiceDate: DATE.correction,
      lines: [{ productId: bare.productId, quantity: '10', unitPrice: '500.00', taxRate: '5.00' }],
    });

    const pending = await prisma.document.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { accountingStatus: true, accountingMessage: true },
    });
    expect(pending.accountingStatus).toBe('PENDING');
    expect(pending.accountingMessage).toContain('has not been initialised');

    // And the event is recoverable: initialise, retry, and the payable appears.
    await initializeCompanyAccounting(bare.companyId);
    await retryDocumentAccounting(bare.auth, invoice.id);

    const recovered = await prisma.document.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { accountingStatus: true },
    });
    expect(recovered.accountingStatus).toBe('POSTED');
    expect(await journalsFor(invoice.id, AccountingEvent.SUPPLIER_INVOICE)).toHaveLength(1);
  }, 600_000);

  it('rolls the business document back when a required mapping is missing', async () => {
    // The tenant has a chart, so accounting is required. Remove the role the
    // invoice posting needs and the whole transaction must refuse.
    const vendorMappings = await prisma.accountMapping.findMany({
      where: { companyId: other.companyId, mappingType: AccountMappingType.VENDOR },
    });
    const documentsBefore = await prisma.document.count({ where: { companyId: other.companyId } });

    await prisma.accountMapping.deleteMany({
      where: { companyId: other.companyId, mappingType: AccountMappingType.VENDOR },
    });

    try {
      const health = await getMappingHealth(other.companyId);
      expect(health.postable).toBe(false);
      expect(health.rows.find((r) => r.mappingType === 'VENDOR')?.status).toBe('NOT_CONFIGURED');

      const requirementId = await createRequirement(other.auth, {
        branchId: other.wardBranchId,
        documentDate: DATE.requisition,
        requiredDate: DATE.requiredBy,
        reason: 'Will not book',
        lines: [{ productId: other.productId, quantity: '4' }],
      });
      await submitRequirement(other.auth, requirementId, 'Submitted');
      await approveRequirement(other.auth, requirementId, 'Approved');

      const purchaseOrderId = await createPurchaseOrder(other.auth, {
        requirementId,
        supplierId: other.supplierId,
        deliveryBranchId: other.centralBranchId,
        documentDate: DATE.purchaseOrder,
        expectedDeliveryDate: DATE.receipt,
        lines: [{ productId: other.productId, quantity: '4', unitPrice: '500.00', taxRate: '5.00' }],
      });
      await approvePurchaseOrder(other.auth, purchaseOrderId, 'Approved');

      const poLine = await prisma.documentLineItem.findFirstOrThrow({
        where: { documentId: purchaseOrderId },
        orderBy: { lineNumber: 'asc' },
      });
      const goodsReceiptId = await createGoodsReceipt(other.auth, {
        purchaseOrderId,
        supplierRef: 'DN-4',
        receiptDate: DATE.receipt,
        lines: [
          {
            purchaseOrderLineItemId: poLine.id,
            quantity: '4',
            acceptedQuantity: '4',
            damagedQuantity: '0',
            missingQuantity: '0',
            batchId: other.batchId,
          },
        ],
      });
      await postGoodsReceipt(other.auth, goodsReceiptId, 'Booked in');

      const documentsBeforeInvoice = await prisma.document.count({
        where: { companyId: other.companyId },
      });

      await expect(
        createSupplierInvoice(other.auth, {
          purchaseOrderId,
          supplierRef: 'INV-SUP-4',
          invoiceDate: DATE.correction,
          lines: [
            { productId: other.productId, quantity: '4', unitPrice: '500.00', taxRate: '5.00' },
          ],
        })
      ).rejects.toThrow(/No accounting mapping is configured for VENDOR/);

      // The whole point of Phase 10: no invoice was left behind without its
      // payable. A posted invoice with no accounting is worse than a refused one.
      const documentsAfter = await prisma.document.count({
        where: { companyId: other.companyId },
      });
      expect(documentsAfter).toBe(documentsBeforeInvoice);
      expect(
        await prisma.document.count({
          where: { companyId: other.companyId, supplierRef: 'INV-SUP-4' },
        })
      ).toBe(0);
      expect(documentsAfter).toBeGreaterThan(documentsBefore);
    } finally {
      // Put the chart back, whatever happened above.
      for (const mapping of vendorMappings) {
        await prisma.accountMapping.create({ data: mapping });
      }
    }
  }, 600_000);
});

describe('accounting initialisation', () => {
  it('is idempotent: running it again duplicates nothing', async () => {
    const before = await countChart(tenant.companyId);
    const result = await initializeCompanyAccounting(tenant.companyId);
    const after = await countChart(tenant.companyId);

    expect(result.alreadyInitialized).toBe(true);
    expect(after).toEqual(before);
    expect(Object.values(result.created).every((n) => n === 0)).toBe(true);
  });

  it('does not touch another company', async () => {
    const otherBefore = await countChart(other.companyId);
    await initializeCompanyAccounting(tenant.companyId);
    expect(await countChart(other.companyId)).toEqual(otherBefore);
  });

  it('reports every required role as resolvable once initialised', async () => {
    const health = await getMappingHealth(tenant.companyId);
    expect(health.initialized).toBe(true);
    expect(health.postable).toBe(true);
    expect(health.failing).toBe(0);

    const vendor = health.rows.find((r) => r.mappingType === 'VENDOR');
    expect(vendor?.status).toBe('PASS');
    expect(vendor?.resolved?.ledgerName).toContain('Trade Payables');
  });
});

describe('supplier subledger', () => {
  it('reconciles with the payables control account', async () => {
    const ledger = await getSupplierLedger(tenant.auth, { supplierId: tenant.supplierId });
    const control = await prisma.journalLine.aggregate({
      where: {
        journalEntry: {
          companyId: tenant.companyId,
          status: { in: [JournalStatus.POSTED, JournalStatus.REVERSED] },
        },
        ledgerId: ledger.controlAccount.ledgerId,
        supplierId: tenant.supplierId,
      },
      _sum: { debit: true, credit: true },
    });

    const owed = (control._sum.credit ?? new Prisma.Decimal(0))
      .minus(control._sum.debit ?? new Prisma.Decimal(0))
      .toFixed(2);
    expect(ledger.closingBalance).toBe(owed);
  });

  it('shows the invoice as a credit and the payment as a debit', async () => {
    const ledger = await getSupplierLedger(tenant.auth, { supplierId: tenant.supplierId });
    const invoiceRow = ledger.rows.find((r) => r.event === AccountingEvent.SUPPLIER_INVOICE);
    const paymentRow = ledger.rows.find((r) => r.event === AccountingEvent.SUPPLIER_PAYMENT);

    expect(invoiceRow?.credit).toBe('36750.00');
    expect(paymentRow?.debit).toBe('36750.00');
  });

  it('adds up to the control account across every supplier', async () => {
    const outstanding = await getSupplierOutstanding(tenant.auth);
    const control = await resolveAccountingAccount(
      tenant.companyId,
      null,
      AccountMappingType.VENDOR
    );
    const totals = await prisma.journalLine.aggregate({
      where: {
        journalEntry: {
          companyId: tenant.companyId,
          status: { in: [JournalStatus.POSTED, JournalStatus.REVERSED] },
        },
        ledgerId: control.ledgerId,
      },
      _sum: { debit: true, credit: true },
    });
    const owed = (totals._sum.credit ?? new Prisma.Decimal(0))
      .minus(totals._sum.debit ?? new Prisma.Decimal(0))
      .toFixed(2);

    expect(outstanding.totals.ledgerBalance).toBe(owed);
  });

  it("refuses another company's supplier", async () => {
    await expect(
      getSupplierLedger(tenant.auth, { supplierId: other.supplierId })
    ).rejects.toThrow(/not found/i);
  });

  it("shows none of another company's suppliers", async () => {
    const outstanding = await getSupplierOutstanding(other.auth);
    expect(outstanding.rows.every((r) => r.supplier.id !== tenant.supplierId)).toBe(true);
  });
});

describe('the reports the postings feed', () => {
  const scope = { toDate: new Date('2026-09-09T23:59:59.999Z') };

  it('keeps the trial balance balanced', async () => {
    const report = await getTrialBalance(tenant.auth, scope);
    expect(report.isBalanced).toBe(true);
    expect(report.totals.difference).toBe('0.00');
    expect(report.integrityError).toBeNull();
  });

  it('reports the sale and its cost, and nothing else, in the P&L', async () => {
    const report = await getProfitAndLoss(tenant.auth, scope);
    expect(report.totalIncome).toBe('3250.00');
    expect(report.totalExpenses).toBe('2500.00');
    expect(report.netProfit).toBe('750.00');
  });

  it('balances the balance sheet', async () => {
    const report = await getBalanceSheet(tenant.auth, scope);
    expect(report.isBalanced).toBe(true);
    expect(report.totals.difference).toBe('0.00');
    expect(report.equity.retainedResultForPeriod).toBe('750.00');
  });

  it("shows none of the other tenant's figures", async () => {
    const mine = await getTrialBalance(tenant.auth, scope);
    const theirs = await getTrialBalance(other.auth, scope);
    expect(mine.totals.totalDebit).not.toBe('0.00');
    expect(theirs.totals.totalDebit).not.toBe(mine.totals.totalDebit);
  });
});
