import { prisma, disconnectDatabase } from '../database/prisma';
import { logger } from '../loggers';

async function verifySeed() {
  const [companies, branches, suppliers, products, users, batches, documents, movements] =
    await Promise.all([
      prisma.company.findMany({ select: { code: true, name: true } }),
      prisma.branch.findMany({ select: { code: true, name: true, type: true } }),
      prisma.supplier.count(),
      prisma.product.count(),
      prisma.user.findMany({
        select: { email: true, role: true, branchScope: true, branchId: true },
      }),
      prisma.batch.count(),
      prisma.document.count(),
      prisma.inventoryTransaction.count(),
    ]);

  logger.info('Seed verification', {
    companies,
    branches,
    suppliers,
    products,
    batches,
    users,
    documents,
    inventoryTransactions: movements,
  });
}

verifySeed()
  .catch((error) => logger.error('Seed verification failed', { reason: String(error) }))
  .finally(disconnectDatabase);
