import { BranchType, Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { conflict, forbidden, notFound } from '../utils/errors';
import { Pagination, pageMeta, paginate } from '../schemas/common';
import { isBranchInScope } from './authorization.service';
import { Permission } from '../constants/permissions';
import { invalidateBranch } from '../cache/branchCache';

export interface BranchListQuery extends Pagination {
  type?: BranchType;
  isActive?: boolean;
  scope?: 'scope' | 'company';
}

export interface BranchInput {
  code: string;
  name: string;
  type: BranchType;
  address?: string;
  isActive?: boolean;
}

/** Branch-scoped users only ever see the branches they may operate in. */
function scopeWhere(auth: AuthContext): Prisma.BranchWhereInput {
  const where: Prisma.BranchWhereInput = { companyId: auth.companyId };
  if (!auth.hasAllBranches) {
    where.id = { in: auth.allowedBranchIds };
  }
  return where;
}

/**
 * Naming a stock transfer destination is the one read that legitimately reaches
 * outside the caller's branch scope, so it is gated on the permission to raise a
 * transfer (or to manage branches) rather than on branch scope.
 */
function assertMayListCompanyBranches(auth: AuthContext) {
  const allowed =
    auth.permissions.includes(Permission.STOCK_TRANSFER_CREATE) ||
    auth.permissions.includes(Permission.BRANCH_MANAGE);
  if (!allowed) {
    throw forbidden('Not permitted to list branches outside your scope');
  }
}

export async function listBranches(auth: AuthContext, query: BranchListQuery) {
  if (query.scope === 'company') {
    assertMayListCompanyBranches(auth);
  }
  const where =
    query.scope === 'company' ? { companyId: auth.companyId } : scopeWhere(auth);
  if (query.type) where.type = query.type;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { code: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [total, data] = await Promise.all([
    prisma.branch.count({ where }),
    prisma.branch.findMany({
      where,
      ...paginate(query),
      orderBy: { [query.sortBy === 'name' ? 'name' : 'code']: query.sortOrder },
    }),
  ]);

  return { data, meta: pageMeta(query, total) };
}

export async function getBranch(auth: AuthContext, id: string) {
  const branch = await prisma.branch.findFirst({
    where: { id, companyId: auth.companyId },
  });
  if (!branch || !isBranchInScope(auth, branch.id)) {
    throw notFound('Branch not found');
  }
  return branch;
}

export async function createBranch(auth: AuthContext, input: BranchInput) {
  const existing = await prisma.branch.findFirst({
    where: { companyId: auth.companyId, code: input.code },
  });
  if (existing) {
    throw conflict('A branch with code ' + input.code + ' already exists');
  }

  const branch = await prisma.branch.create({
    data: {
      companyId: auth.companyId,
      code: input.code,
      name: input.name,
      type: input.type,
      address: input.address,
      isActive: input.isActive ?? true,
    },
  });
  invalidateBranch(branch.id);
  return branch;
}

export async function updateBranch(auth: AuthContext, id: string, input: Partial<BranchInput>) {
  const branch = await prisma.branch.findFirst({
    where: { id, companyId: auth.companyId },
  });
  if (!branch) {
    throw notFound('Branch not found');
  }

  if (input.code && input.code !== branch.code) {
    const duplicate = await prisma.branch.findFirst({
      where: { companyId: auth.companyId, code: input.code, id: { not: id } },
    });
    if (duplicate) {
      throw conflict('A branch with code ' + input.code + ' already exists');
    }
  }

  const updated = await prisma.branch.update({ where: { id }, data: input });
  invalidateBranch(id);
  return updated;
}
