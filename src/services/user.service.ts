import { BranchScopeType, Prisma, UserRole } from '@prisma/client';
import { prisma, transaction } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { badRequest, conflict, notFound } from '../utils/errors';
import { hashPassword } from '../utils/password';
import { Pagination, pageMeta, paginate } from '../schemas/common';
import { permissionsForRole } from '../constants/permissions';

export interface UserListQuery extends Pagination {
  role?: UserRole;
  isActive?: boolean;
  branchId?: string;
}

export interface UserInput {
  email: string;
  name: string;
  password: string;
  role: UserRole;
  branchScope: BranchScopeType;
  branchId?: string | null;
  branchIds?: string[];
  isActive?: boolean;
}

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  branchScope: true,
  branchId: true,
  companyId: true,
  createdAt: true,
  branch: { select: { id: true, code: true, name: true, type: true } },
  branchAccess: { select: { branch: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.UserSelect;

type SelectedUser = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function serialize(user: SelectedUser) {
  const { branchAccess, ...rest } = user;
  return {
    ...rest,
    branches: branchAccess.map((a) => a.branch),
    permissions: permissionsForRole(user.role),
  };
}

/** Every branch named for a user must belong to the caller company. */
async function assertBranchesInCompany(companyId: string, branchIds: string[]) {
  if (branchIds.length === 0) {
    return;
  }
  const found = await prisma.branch.count({
    where: { companyId, id: { in: branchIds } },
  });
  if (found !== new Set(branchIds).size) {
    throw notFound('One or more branches were not found');
  }
}

function validateScope(input: Pick<UserInput, 'branchScope' | 'branchId' | 'branchIds'>) {
  if (input.branchScope === BranchScopeType.SPECIFIC_BRANCHES) {
    const hasAny = Boolean(input.branchId) || (input.branchIds?.length ?? 0) > 0;
    if (!hasAny) {
      throw badRequest('A branch-scoped user must be assigned at least one branch');
    }
  }
}

export async function listUsers(auth: AuthContext, query: UserListQuery) {
  const where: Prisma.UserWhereInput = { companyId: auth.companyId };
  if (query.role) where.role = query.role;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.branchId) where.branchId = query.branchId;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      ...paginate(query),
      orderBy: { [query.sortBy === 'name' ? 'name' : 'email']: query.sortOrder },
      select: USER_SELECT,
    }),
  ]);

  return { data: rows.map(serialize), meta: pageMeta(query, total) };
}

export async function getUser(auth: AuthContext, id: string) {
  const user = await prisma.user.findFirst({
    where: { id, companyId: auth.companyId },
    select: USER_SELECT,
  });
  if (!user) {
    throw notFound('User not found');
  }
  return serialize(user);
}

export async function createUser(auth: AuthContext, input: UserInput) {
  validateScope(input);

  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw conflict('A user with this email already exists');
  }

  const branchIds = Array.from(
    new Set([...(input.branchId ? [input.branchId] : []), ...(input.branchIds ?? [])])
  );
  await assertBranchesInCompany(auth.companyId, branchIds);

  const user = await prisma.user.create({
    data: {
      companyId: auth.companyId,
      email,
      name: input.name,
      role: input.role,
      passwordHash: await hashPassword(input.password),
      isActive: input.isActive ?? true,
      branchScope: input.branchScope,
      branchId: input.branchId ?? null,
      branchAccess: {
        create: branchIds
          .filter((id) => id !== input.branchId)
          .map((branchId) => ({ branchId })),
      },
    },
    select: USER_SELECT,
  });

  return serialize(user);
}

export async function updateUser(
  auth: AuthContext,
  id: string,
  input: Partial<UserInput>
) {
  const user = await prisma.user.findFirst({
    where: { id, companyId: auth.companyId },
  });
  if (!user) {
    throw notFound('User not found');
  }

  const branchScope = input.branchScope ?? user.branchScope;
  const branchId = input.branchId !== undefined ? input.branchId : user.branchId;
  validateScope({ branchScope, branchId, branchIds: input.branchIds });

  const data: Prisma.UserUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.role !== undefined) data.role = input.role;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.password !== undefined) data.passwordHash = await hashPassword(input.password);
  if (input.branchScope !== undefined) data.branchScope = input.branchScope;
  if (input.branchId !== undefined) {
    if (input.branchId) {
      await assertBranchesInCompany(auth.companyId, [input.branchId]);
      data.branch = { connect: { id: input.branchId } };
    } else {
      data.branch = { disconnect: true };
    }
  }

  return transaction(async (tx) => {
    if (input.branchIds) {
      await assertBranchesInCompany(auth.companyId, input.branchIds);
      await tx.userBranchAccess.deleteMany({ where: { userId: id } });
      const extra = input.branchIds.filter((b) => b !== branchId);
      if (extra.length > 0) {
        await tx.userBranchAccess.createMany({
          data: extra.map((b) => ({ userId: id, branchId: b })),
        });
      }
    }
    const updated = await tx.user.update({ where: { id }, data, select: USER_SELECT });
    return serialize(updated);
  });
}
