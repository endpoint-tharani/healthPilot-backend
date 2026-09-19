import { BranchScopeType, BranchType, UserRole } from '@prisma/client';
import { disconnectDatabase, prisma } from '../database/prisma';
import { hashPassword } from '../utils/password';
import { logger } from '../loggers';

const DEFAULT_PASSWORD = process.env.SEED_PASSWORD || 'Password123!';

/**
 * Development seed. It clears transactional records so document numbering starts
 * at 0001 for a fresh run; the API itself never deletes posted documents or
 * inventory transactions.
 */
async function resetTransactionalData() {
  await prisma.$transaction([
    prisma.documentLog.deleteMany(),
    prisma.paymentAllocation.deleteMany(),
    prisma.inventoryTransaction.deleteMany(),
    prisma.documentLink.deleteMany(),
    prisma.documentLineItem.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.document.deleteMany(),
    prisma.refreshToken.deleteMany(),
  ]);
}

async function seedCompanyA(passwordHash: string) {
  const company = await prisma.company.upsert({
    where: { code: 'COMP-HEALTHPILOT' },
    update: { isActive: true },
    create: { code: 'COMP-HEALTHPILOT', name: 'HealthPilot Hospital' },
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

  // Remove Part 1 demo users that no longer fit the Part 2 role model.
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

  // Drop Part 1 branches that were superseded by the BR-* codes, once nothing refers to them.
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
    where: { code: 'COMP-OTHERCARE' },
    update: { isActive: true },
    create: { code: 'COMP-OTHERCARE', name: 'OtherCare Hospital' },
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

async function main() {
  const passwordHash = await hashPassword(DEFAULT_PASSWORD);

  await resetTransactionalData();
  const a = await seedCompanyA(passwordHash);
  const b = await seedCompanyB(passwordHash);

  logger.info('Seed completed', {
    companyA: { name: a.company.name, branches: Object.keys(a.branches) },
    companyB: { name: b.company.name, branches: ['BR-MAIN'] },
  });
  logger.info('All seeded users share the password set by SEED_PASSWORD (default Password123!)');
}

main()
  .catch((error) => {
    logger.error('Seed failed', { reason: String(error) });
    process.exit(1);
  })
  .finally(disconnectDatabase);
