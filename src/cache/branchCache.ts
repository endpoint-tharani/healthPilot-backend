import { Branch } from '@prisma/client';
import { TtlCache } from './ttlCache';
import { BRANCH_CACHE_TTL_MS } from '../constants/cache';
import { Database } from '../database/prisma';

const cache = new TtlCache<Branch>(BRANCH_CACHE_TTL_MS);

/**
 * Branch lookups happen on almost every authorization check. The cached record
 * always carries its own companyId, and the tenant is re-checked on every read,
 * so a cache hit can never widen access across companies.
 */
export async function findBranchInCompany(
  db: Database,
  companyId: string,
  branchId: string
): Promise<Branch | null> {
  const cached = cache.get(branchId);
  if (cached) {
    return cached.companyId === companyId ? cached : null;
  }

  const branch = await db.branch.findUnique({ where: { id: branchId } });
  if (!branch) {
    return null;
  }

  cache.set(branch.id, branch);
  return branch.companyId === companyId ? branch : null;
}

export function invalidateBranch(branchId: string): void {
  cache.delete(branchId);
}

export function invalidateAllBranches(): void {
  cache.clear();
}
