import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { conflict, notFound } from '../utils/errors';
import { Pagination, pageMeta, paginate } from '../schemas/common';

export interface SupplierListQuery extends Pagination {
  isActive?: boolean;
}

export interface SupplierInput {
  code: string;
  name: string;
  contactInfo?: string;
  address?: string;
  isActive?: boolean;
}

export async function listSuppliers(auth: AuthContext, query: SupplierListQuery) {
  const where: Prisma.SupplierWhereInput = { companyId: auth.companyId };
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { code: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [total, data] = await Promise.all([
    prisma.supplier.count({ where }),
    prisma.supplier.findMany({
      where,
      ...paginate(query),
      orderBy: { [query.sortBy === 'name' ? 'name' : 'code']: query.sortOrder },
    }),
  ]);

  return { data, meta: pageMeta(query, total) };
}

export async function getSupplier(auth: AuthContext, id: string) {
  const supplier = await prisma.supplier.findFirst({
    where: { id, companyId: auth.companyId },
  });
  if (!supplier) {
    throw notFound('Supplier not found');
  }
  return supplier;
}

export async function createSupplier(auth: AuthContext, input: SupplierInput) {
  const existing = await prisma.supplier.findFirst({
    where: { companyId: auth.companyId, code: input.code },
  });
  if (existing) {
    throw conflict('A supplier with code ' + input.code + ' already exists');
  }

  return prisma.supplier.create({
    data: {
      companyId: auth.companyId,
      code: input.code,
      name: input.name,
      contactInfo: input.contactInfo,
      address: input.address,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateSupplier(
  auth: AuthContext,
  id: string,
  input: Partial<SupplierInput>
) {
  const supplier = await prisma.supplier.findFirst({
    where: { id, companyId: auth.companyId },
  });
  if (!supplier) {
    throw notFound('Supplier not found');
  }

  if (input.code && input.code !== supplier.code) {
    const duplicate = await prisma.supplier.findFirst({
      where: { companyId: auth.companyId, code: input.code, id: { not: id } },
    });
    if (duplicate) {
      throw conflict('A supplier with code ' + input.code + ' already exists');
    }
  }

  return prisma.supplier.update({ where: { id }, data: input });
}
