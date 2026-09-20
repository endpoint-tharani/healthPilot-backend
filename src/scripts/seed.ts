import { BranchScopeType, BranchType, PaymentMethod, UserRole } from '@prisma/client';
import { disconnectDatabase, prisma } from '../database/prisma';
import { hashPassword } from '../utils/password';
import { logger } from '../loggers';
import { AuthContext } from '../context/authContext';
import { permissionsForRole } from '../constants/permissions';
import {
  approveRequirement,
  createRequirement,
  submitRequirement,
} from '../services/stockRequirement.service';
import { approvePurchaseOrder, createPurchaseOrder } from '../services/purchaseOrder.service';
import { createGoodsReceipt, postGoodsReceipt } from '../services/goodsReceipt.service';
import { createReceiptCorrection } from '../services/receiptCorrection.service';
import { createSupplierInvoice } from '../services/supplierInvoice.service';
import { createCreditNote } from '../services/creditNote.service';
import { createPayment } from '../services/payment.service';
import {
  createStockTransfer,
  dispatchStockTransfer,
  receiveStockTransfer,
} from '../services/stockTransfer.service';
import { createDispensing } from '../services/dispensing.service';

const DEFAULT_PASSWORD = process.env.SEED_PASSWORD || 'Password123!';

/**
 * The two tenants this seed owns. Nothing outside these codes is ever read for
 * deletion, which is the point of the scoping: the previous version cleared
 * every document, payment and stock movement in the database, so running it
 * against a shared or deployed instance destroyed other companies' books. A
 * tenant that signed up through the API is not demo data.
 */
const DEMO_COMPANY_CODE = 'COMP-HEALTHPILOT';
const ISOLATION_COMPANY_CODE = 'COMP-OTHERCARE';

/**
 * The master data each demo tenant is supposed to have. Anything else in these
 * two tenants that nothing refers to any more is left over from a verification
 * run - the internal-fulfilment harness creates its own products and batches on
 * every pass - and is pruned, so the demo opens on one product and one batch
 * rather than on two hundred test rows a reviewer has to scroll past.
 *
 * Only these two tenants are ever pruned, and only rows with no documents, no
 * line items and no stock movements behind them.
 */
const DEMO_MASTER_DATA: Record<string, { products: string[]; suppliers: string[]; batches: string[] }> = {
  [DEMO_COMPANY_CODE]: {
    products: ['PRD-INS-001'],
    suppliers: ['SUP-MEDISUPPLY'],
    batches: ['IG-SEP26-01'],
  },
  [ISOLATION_COMPANY_CODE]: {
    products: ['PRD-OTH-001'],
    suppliers: ['SUP-OTHER'],
    batches: [],
  },
};

function businessDate(day: string): Date {
  return new Date(day + 'T00:00:00.000Z');
}

/** The official scenario's business dates. */
const DATE = {
  requisitions: businessDate('2026-09-01'),
  purchaseOrder: businessDate('2026-09-02'),
  goodsReceipt: businessDate('2026-09-05'),
  correction: businessDate('2026-09-06'),
  transfer: businessDate('2026-09-09'),
  requiredBy: businessDate('2026-09-08'),
  invoiceDue: businessDate('2026-10-06'),
};

/* ------------------------------------------------------------- tenant reset ---- */

/**
 * Clears one company's transactional history so a seeded run starts from an
 * empty ledger and document numbering restarts at 0001.
 *
 * Every statement is scoped by companyId - directly where the table carries one,
 * through its owning row where it does not. Master data (the company, its
 * branches, users, suppliers, products and batches) is upserted rather than
 * deleted, so ids stay stable across runs and nothing another tenant could
 * reference is touched.
 *
 * The order is the foreign-key order: rows that point at documents go before the
 * documents they point at.
 */
async function resetCompanyTransactions(companyId: string, companyCode: string) {
  const [documents, movements, payments] = await Promise.all([
    prisma.document.count({ where: { companyId } }),
    prisma.inventoryTransaction.count({ where: { companyId } }),
    prisma.payment.count({ where: { companyId } }),
  ]);

  await prisma.$transaction([
    prisma.documentLog.deleteMany({ where: { companyId } }),
    prisma.notification.deleteMany({ where: { companyId } }),
    prisma.paymentAllocation.deleteMany({
      where: { OR: [{ payment: { companyId } }, { document: { companyId } }] },
    }),
    prisma.inventoryTransaction.deleteMany({ where: { companyId } }),
    prisma.documentLink.deleteMany({ where: { companyId } }),
    prisma.documentLineItem.deleteMany({ where: { document: { companyId } } }),
    prisma.payment.deleteMany({ where: { companyId } }),
    prisma.document.deleteMany({ where: { companyId } }),
    prisma.refreshToken.deleteMany({ where: { user: { companyId } } }),
  ]);

  logger.info('Cleared demo tenant transactions', {
    company: companyCode,
    documents,
    inventoryTransactions: movements,
    payments,
  });
}

/**
 * Removes master data in a demo tenant that is not part of the demo and that
 * nothing refers to.
 *
 * Run after the transactional reset, so "refers to" is judged against the books
 * as they will actually be. A row with any line item or stock movement still
 * pointing at it is left alone whatever its code, which is what keeps this from
 * being able to break referential integrity.
 */
async function pruneOrphanMasterData(companyId: string, companyCode: string): Promise<void> {
  const keep = DEMO_MASTER_DATA[companyCode];
  if (!keep) {
    return;
  }

  const batches = await prisma.batch.deleteMany({
    where: {
      companyId,
      batchNumber: { notIn: keep.batches },
      lineItems: { none: {} },
      inventoryTransactions: { none: {} },
    },
  });

  const products = await prisma.product.deleteMany({
    where: {
      companyId,
      code: { notIn: keep.products },
      batches: { none: {} },
      lineItems: { none: {} },
      inventoryTransactions: { none: {} },
    },
  });

  const suppliers = await prisma.supplier.deleteMany({
    where: {
      companyId,
      code: { notIn: keep.suppliers },
      documents: { none: {} },
      payments: { none: {} },
    },
  });

  if (batches.count + products.count + suppliers.count > 0) {
    logger.info('Pruned orphan demo master data', {
      company: companyCode,
      batches: batches.count,
      products: products.count,
      suppliers: suppliers.count,
    });
  }
}

/** Clears only the tenants this seed owns, and only those that already exist. */
async function resetDemoTenants(): Promise<void> {
  const companies = await prisma.company.findMany({
    where: { code: { in: [DEMO_COMPANY_CODE, ISOLATION_COMPANY_CODE] } },
    select: { id: true, code: true },
  });
  for (const company of companies) {
    await resetCompanyTransactions(company.id, company.code);
    await pruneOrphanMasterData(company.id, company.code);
  }
}

/* ------------------------------------------------------------- master data ---- */

async function seedCompanyA(passwordHash: string) {
  const company = await prisma.company.upsert({
    where: { code: DEMO_COMPANY_CODE },
    update: { isActive: true },
    create: { code: DEMO_COMPANY_CODE, name: 'HealthPilot Hospital' },
  });

  const branchDefs = [
    {
      code: 'BR-CENTRAL',
      name: 'Central Pharmacy Warehouse',
      type: BranchType.CENTRAL_WAREHOUSE,
      address: 'Main Logistics Hub, Block C',
    },
    { code: 'BR-A', name: 'Branch A', type: BranchType.BRANCH, address: 'North Wing Hospital Campus' },
    { code: 'BR-B', name: 'Branch B', type: BranchType.BRANCH, address: 'East Annex Medical Center' },
    { code: 'BR-C', name: 'Branch C', type: BranchType.BRANCH, address: 'South Outpatient Clinic' },
  ];

  const branches: Record<string, string> = {};
  for (const def of branchDefs) {
    const branch = await prisma.branch.upsert({
      where: { companyId_code: { companyId: company.id, code: def.code } },
      update: { name: def.name, type: def.type, isActive: true },
      create: { companyId: company.id, ...def },
    });
    branches[def.code] = branch.id;
  }

  const supplier = await prisma.supplier.upsert({
    where: { companyId_code: { companyId: company.id, code: 'SUP-MEDISUPPLY' } },
    update: { isActive: true },
    create: {
      companyId: company.id,
      code: 'SUP-MEDISUPPLY',
      name: 'MediSupply Pharmaceuticals Pvt. Ltd.',
      contactInfo: 'orders@medisupply.com, +91-80-5555-0100',
      address: 'Plot 42, Pharma Park, Bengaluru',
    },
  });

  const product = await prisma.product.upsert({
    where: { companyId_code: { companyId: company.id, code: 'PRD-INS-001' } },
    update: { isActive: true },
    create: {
      companyId: company.id,
      code: 'PRD-INS-001',
      name: 'Insulin Glargine 100 IU/ml',
      unit: 'Vial',
      purchasePrice: '500.00',
      sellingPrice: '650.00',
      taxRate: '5.00',
      minTemp: '2.00',
      maxTemp: '8.00',
    },
  });

  const batch = await prisma.batch.upsert({
    where: { productId_batchNumber: { productId: product.id, batchNumber: 'IG-SEP26-01' } },
    update: {},
    create: {
      companyId: company.id,
      productId: product.id,
      batchNumber: 'IG-SEP26-01',
      expiryDate: new Date('2028-08-31T00:00:00.000Z'),
    },
  });

  const users = [
    {
      email: 'admin@healthpilot.ai',
      name: 'Company Admin',
      role: UserRole.COMPANY_ADMIN,
      branchScope: BranchScopeType.ALL_BRANCHES,
      branchId: null,
    },
    {
      email: 'central@healthpilot.ai',
      name: 'Central Pharmacy User',
      role: UserRole.CENTRAL_PHARMACY,
      branchScope: BranchScopeType.SPECIFIC_BRANCHES,
      branchId: branches['BR-CENTRAL'],
    },
    {
      email: 'brancha@healthpilot.ai',
      name: 'Branch A Pharmacist',
      role: UserRole.PHARMACIST,
      branchScope: BranchScopeType.SPECIFIC_BRANCHES,
      branchId: branches['BR-A'],
    },
    {
      email: 'branchb@healthpilot.ai',
      name: 'Branch B Pharmacist',
      role: UserRole.PHARMACIST,
      branchScope: BranchScopeType.SPECIFIC_BRANCHES,
      branchId: branches['BR-B'],
    },
    {
      email: 'branchc@healthpilot.ai',
      name: 'Branch C Pharmacist',
      role: UserRole.PHARMACIST,
      branchScope: BranchScopeType.SPECIFIC_BRANCHES,
      branchId: branches['BR-C'],
    },
    {
      email: 'inactive@healthpilot.ai',
      name: 'Deactivated Staff',
      role: UserRole.STAFF,
      branchScope: BranchScopeType.SPECIFIC_BRANCHES,
      branchId: branches['BR-A'],
      isActive: false,
    },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        name: user.name,
        role: user.role,
        passwordHash,
        branchScope: user.branchScope,
        branchId: user.branchId,
        isActive: user.isActive ?? true,
        companyId: company.id,
      },
      create: {
        companyId: company.id,
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash,
        branchScope: user.branchScope,
        branchId: user.branchId,
        isActive: user.isActive ?? true,
      },
    });
  }

  // Remove Part 1 demo users that no longer fit the Part 2 role model. Scoped to
  // this company, and to email addresses this seed created itself.
  await prisma.user.deleteMany({
    where: {
      companyId: company.id,
      email: {
        in: [
          'po@healthpilot.ai',
          'wh@healthpilot.ai',
          'branch.a@healthpilot.ai',
          'branch.b@healthpilot.ai',
          'branch.c@healthpilot.ai',
        ],
      },
    },
  });

  // Drop Part 1 branches that were superseded by the BR-* codes, once nothing
  // refers to them. Branch ids are company-scoped, so these counts cannot see
  // another tenant's data.
  const stale = await prisma.branch.findMany({
    where: { companyId: company.id, code: { notIn: branchDefs.map((d) => d.code) } },
    select: { id: true, code: true },
  });
  for (const branch of stale) {
    const [users, documents, movements, payments] = await Promise.all([
      prisma.user.count({ where: { branchId: branch.id } }),
      prisma.document.count({
        where: {
          OR: [
            { branchId: branch.id },
            { sourceBranchId: branch.id },
            { destinationBranchId: branch.id },
          ],
        },
      }),
      prisma.inventoryTransaction.count({ where: { branchId: branch.id } }),
      prisma.payment.count({ where: { branchId: branch.id } }),
    ]);
    if (users + documents + movements + payments === 0) {
      await prisma.userBranchAccess.deleteMany({ where: { branchId: branch.id } });
      await prisma.branch.delete({ where: { id: branch.id } });
      logger.info('Removed superseded branch', { code: branch.code });
    }
  }

  return { company, branches, supplier, product, batch };
}

/** A second tenant, used to prove cross-company isolation. */
async function seedCompanyB(passwordHash: string) {
  const company = await prisma.company.upsert({
    where: { code: ISOLATION_COMPANY_CODE },
    update: { isActive: true },
    create: { code: ISOLATION_COMPANY_CODE, name: 'OtherCare Hospital' },
  });

  const branch = await prisma.branch.upsert({
    where: { companyId_code: { companyId: company.id, code: 'BR-MAIN' } },
    update: {},
    create: {
      companyId: company.id,
      code: 'BR-MAIN',
      name: 'OtherCare Main Pharmacy',
      type: BranchType.CENTRAL_WAREHOUSE,
    },
  });

  await prisma.supplier.upsert({
    where: { companyId_code: { companyId: company.id, code: 'SUP-OTHER' } },
    update: {},
    create: { companyId: company.id, code: 'SUP-OTHER', name: 'OtherCare Supplies Ltd.' },
  });

  await prisma.product.upsert({
    where: { companyId_code: { companyId: company.id, code: 'PRD-OTH-001' } },
    update: {},
    create: {
      companyId: company.id,
      code: 'PRD-OTH-001',
      name: 'Paracetamol 500mg',
      unit: 'Strip',
      purchasePrice: '20.00',
      sellingPrice: '30.00',
      taxRate: '5.00',
    },
  });

  await prisma.user.upsert({
    where: { email: 'admin@othercare.ai' },
    update: { passwordHash, companyId: company.id, isActive: true },
    create: {
      companyId: company.id,
      email: 'admin@othercare.ai',
      name: 'OtherCare Admin',
      role: UserRole.COMPANY_ADMIN,
      passwordHash,
      branchScope: BranchScopeType.ALL_BRANCHES,
    },
  });

  return { company, branch };
}

/* --------------------------------------------------------- acting identity ---- */

/**
 * The request identity a seeded user would have if they signed in.
 *
 * Built exactly as `authContextFromAccessToken` builds it, minus the token, so
 * the scenario below runs under the same branch scope a real session would: a
 * branch pharmacist really is confined to their branch here, and the central
 * pharmacy user really does have to be the one who receives the delivery. The
 * seed fails if the scenario asks somebody to do something the ERP would refuse,
 * which is most of the value of driving it this way.
 */
async function actingAs(email: string): Promise<AuthContext> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: {
      branch: { select: { id: true, type: true } },
      branchAccess: { select: { branch: { select: { id: true, type: true } } } },
    },
  });

  const hasAllBranches = user.branchScope === BranchScopeType.ALL_BRANCHES;
  const scopedBranches = [
    ...(user.branch ? [user.branch] : []),
    ...user.branchAccess.map((access) => access.branch),
  ];

  return {
    userId: user.id,
    companyId: user.companyId,
    role: user.role,
    scopeType: user.branchScope,
    hasAllBranches,
    allowedBranchIds: hasAllBranches
      ? []
      : Array.from(new Set(scopedBranches.map((branch) => branch.id))),
    hasCentralWarehouseAccess:
      hasAllBranches ||
      scopedBranches.some((branch) => branch.type === BranchType.CENTRAL_WAREHOUSE),
    permissions: permissionsForRole(user.role),
  };
}

/* ------------------------------------------------------------- the scenario ---- */

/**
 * The official HealthPilot demo scenario, raised through the application's own
 * services rather than written into the tables.
 *
 * Every figure the demo shows is therefore produced the way the running system
 * produces it: the invoice dispute comes out of the accepted-quantity rule, the
 * stock positions come out of the ledger movements each posting wrote, the
 * requisition's fulfilment comes out of the branch-aware fulfilment engine, and
 * the document chain is the links the services created. Nothing here inserts a
 * balance, a total or a status directly - if a business rule were wrong, this
 * seed would produce the wrong numbers rather than hide it behind fixtures.
 *
 * Told as it happens in a hospital:
 *
 *   01 Sep  Three branches raise stock requisitions: A 100 vials, B 40, C 60.
 *   02 Sep  Central raises PO-0001 on REQ-0001 for 100 @ 500 (52,500 with tax).
 *   05 Sep  The delivery arrives and GRN-0001 books all 100 as accepted.
 *   06 Sep  Cold-chain inspection finds 20 damaged and 10 never delivered, so
 *           COR-0001 corrects the receipt to 70 usable / 20 damaged / 10 missing.
 *   06 Sep  INV-0001 bills the full 52,500; only 36,750 is payable, so 15,750 is
 *           disputed. CN-0001 clears the dispute and PAY-0001 settles the rest.
 *   09 Sep  TRF-0001 sends 30 of the good vials to Branch A against REQ-0001,
 *           and Branch A receipts them.
 *   09 Sep  DSP-0001 dispenses 5 vials to a patient, paid by card (PAY-0002).
 */
async function seedScenario(masters: {
  branches: Record<string, string>;
  supplierId: string;
  productId: string;
  batchId: string;
}) {
  const central = await actingAs('central@healthpilot.ai');
  const branchAUser = await actingAs('brancha@healthpilot.ai');
  const branchBUser = await actingAs('branchb@healthpilot.ai');
  const branchCUser = await actingAs('branchc@healthpilot.ai');

  const { branches, supplierId, productId, batchId } = masters;

  /* -- 01 Sep: the three branch requisitions ------------------------------- */

  const requirementA = await raiseRequirement(branchAUser, central, {
    branchId: branches['BR-A'],
    productId,
    quantity: '100',
    reason: 'Diabetic ward September cycle: 100 vials of Insulin Glargine',
  });
  const requirementB = await raiseRequirement(branchBUser, central, {
    branchId: branches['BR-B'],
    productId,
    quantity: '40',
    reason: 'Outpatient clinic top-up: 40 vials of Insulin Glargine',
  });
  const requirementC = await raiseRequirement(branchCUser, central, {
    branchId: branches['BR-C'],
    productId,
    quantity: '60',
    reason: 'New endocrinology list: 60 vials of Insulin Glargine',
  });

  /* -- 02 Sep: the purchase order ------------------------------------------ */

  const purchaseOrderId = await createPurchaseOrder(central, {
    requirementId: requirementA,
    supplierId,
    deliveryBranchId: branches['BR-CENTRAL'],
    documentDate: DATE.purchaseOrder,
    expectedDeliveryDate: DATE.goodsReceipt,
    notes: 'Raised against REQ-0001; delivered to the central warehouse for onward transfer',
    lines: [{ productId, quantity: '100', unitPrice: '500.00', taxRate: '5.00' }],
  });
  await approvePurchaseOrder(central, purchaseOrderId, 'Within the September procurement budget');

  const purchaseOrderLine = await firstLineOf(purchaseOrderId);

  /* -- 05 Sep: goods receipt, booked as the supplier claimed --------------- */

  const goodsReceiptId = await createGoodsReceipt(central, {
    purchaseOrderId,
    supplierRef: 'MS-DN-88213',
    receiptDate: DATE.goodsReceipt,
    notes: 'Delivery note MS-DN-88213: 100 vials signed for at the warehouse door',
    lines: [
      {
        purchaseOrderLineItemId: purchaseOrderLine.id,
        quantity: '100',
        acceptedQuantity: '100',
        damagedQuantity: '0',
        missingQuantity: '0',
        batchId,
      },
    ],
  });
  await postGoodsReceipt(central, goodsReceiptId, 'Booked in as delivered');

  const goodsReceiptLine = await firstLineOf(goodsReceiptId);

  /* -- 06 Sep: the correction the whole scenario turns on ------------------ */

  await createReceiptCorrection(central, {
    goodsReceiptId,
    documentDate: DATE.correction,
    reason:
      'Cold-chain audit: 20 vials breached the 2-8C range and were quarantined, ' +
      'and 10 vials on the delivery note never arrived',
    lines: [
      {
        goodsReceiptLineItemId: goodsReceiptLine.id,
        correctedAcceptedQuantity: '70',
        correctedDamagedQuantity: '20',
        correctedMissingQuantity: '10',
      },
    ],
  });

  /* -- 06 Sep: the supplier bills for all 100 ------------------------------ */

  const invoice = await createSupplierInvoice(central, {
    purchaseOrderId,
    supplierRef: 'MS-INV-5521',
    invoiceDate: DATE.correction,
    dueDate: DATE.invoiceDue,
    notes: 'Supplier billed the full ordered quantity',
    lines: [{ productId, quantity: '100', unitPrice: '500.00', taxRate: '5.00' }],
  });

  /* -- 06 Sep: credit note clears the dispute, then we pay what is owed ---- */

  await createCreditNote(central, {
    supplierInvoiceId: invoice.id,
    documentDate: DATE.correction,
    supplierRef: 'MS-CN-5521A',
    reason: '30 vials not usable: 20 damaged in transit and 10 short delivered',
    lines: [{ productId, quantity: '30', unitPrice: '500.00', taxRate: '5.00' }],
  });

  await createPayment(central, {
    supplierId,
    branchId: branches['BR-CENTRAL'],
    amount: '36750.00',
    method: PaymentMethod.BANK_TRANSFER,
    paymentDate: DATE.correction,
    reference: 'NEFT-2026-09-06-0041',
    notes: 'Settles the accepted value of INV-0001 after CN-0001',
    allocations: [{ documentId: invoice.id, amount: '36750.00' }],
  });

  /* -- 09 Sep: 30 vials go to Branch A against its requisition ------------- */

  const transfer = await createStockTransfer(central, {
    sourceBranchId: branches['BR-CENTRAL'],
    destinationBranchId: branches['BR-A'],
    documentDate: DATE.transfer,
    expectedDate: DATE.transfer,
    // This link is what makes the transfer count towards REQ-0001, rather than
    // being an unexplained movement of stock between two branches.
    requirementId: requirementA,
    notes: 'Part fulfilment of REQ-0001 from usable central stock',
    lines: [{ productId, batchId, quantity: '30' }],
  });
  await dispatchStockTransfer(central, transfer.id, 'Cold box sealed and sent to Branch A');
  await receiveStockTransfer(branchAUser, transfer.id, 'Received at Branch A, cold chain intact');

  /* -- 09 Sep: a patient is dispensed 5 vials ------------------------------ */

  const dispensing = await createDispensing(branchAUser, {
    branchId: branches['BR-A'],
    documentDate: DATE.transfer,
    patientRef: 'PAT-100482',
    prescriptionRef: 'RX-2026-09-09-0117',
    paymentMethod: PaymentMethod.CARD,
    notes: 'Outpatient supply, one month',
    lines: [{ productId, batchId, quantity: '5' }],
  });

  return {
    requirementA,
    requirementB,
    requirementC,
    purchaseOrderId,
    goodsReceiptId,
    invoiceId: invoice.id,
    transferId: transfer.id,
    dispensingId: dispensing.id,
  };
}

/** Raise, submit and approve one branch requisition, as the two users involved. */
async function raiseRequirement(
  branchUser: AuthContext,
  approver: AuthContext,
  input: { branchId: string; productId: string; quantity: string; reason: string }
): Promise<string> {
  const id = await createRequirement(branchUser, {
    branchId: input.branchId,
    documentDate: DATE.requisitions,
    requiredDate: DATE.requiredBy,
    reason: input.reason,
    lines: [{ productId: input.productId, quantity: input.quantity }],
  });
  await submitRequirement(branchUser, id, 'Submitted for central approval');
  await approveRequirement(approver, id, 'Approved by central pharmacy');
  return id;
}

async function firstLineOf(documentId: string) {
  return prisma.documentLineItem.findFirstOrThrow({
    where: { documentId },
    orderBy: { lineNumber: 'asc' },
    select: { id: true, productId: true, quantity: true },
  });
}

/* -------------------------------------------------------------------- main ---- */

async function main() {
  const passwordHash = await hashPassword(DEFAULT_PASSWORD);

  // Master data first, so the reset below has tenants to scope itself to; then
  // the reset; then the scenario, on a genuinely empty ledger.
  const a = await seedCompanyA(passwordHash);
  const b = await seedCompanyB(passwordHash);

  await resetDemoTenants();

  // Branch pruning runs again now the tenant's documents are gone: a Part 1
  // branch that was still referenced a moment ago may now be genuinely unused.
  await seedCompanyA(passwordHash);

  const scenario = await seedScenario({
    branches: a.branches,
    supplierId: a.supplier.id,
    productId: a.product.id,
    batchId: a.batch.id,
  });

  const documents = await prisma.document.findMany({
    where: { companyId: a.company.id },
    orderBy: [{ documentDate: 'asc' }, { documentNumber: 'asc' }],
    select: { documentNumber: true, status: true },
  });

  logger.info('Seed completed', {
    companyA: { name: a.company.name, branches: Object.keys(a.branches) },
    companyB: { name: b.company.name, branches: ['BR-MAIN'] },
    scenario: documents.map((d) => d.documentNumber + ' (' + d.status + ')'),
    openRequisitions: [scenario.requirementB, scenario.requirementC].length,
  });
  logger.info('All seeded users share the password set by SEED_PASSWORD (default Password123!)');
  logger.info('Run `npm run verify:scenario` to assert the seeded stock and money positions');
}

main()
  .catch((error) => {
    logger.error('Seed failed', { reason: String(error) });
    process.exit(1);
  })
  .finally(disconnectDatabase);
