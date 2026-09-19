import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { conflict, notFound } from '../utils/errors';
import { money } from '../utils/decimal';
import { Pagination, pageMeta, paginate } from '../schemas/common';

export interface ProductListQuery extends Pagination {
  isActive?: boolean;
}

export interface ProductInput {
  code: string;
  name: string;
  unit: string;
  purchasePrice: string;
  sellingPrice: string;
  taxRate: string;
  trackInventory?: boolean;
  isActive?: boolean;
  minTemp?: string | null;
  maxTemp?: string | null;
}

function serialize(product: {
  purchasePrice: Prisma.Decimal;
  sellingPrice: Prisma.Decimal;
  taxRate: Prisma.Decimal;
  minTemp: Prisma.Decimal | null;
  maxTemp: Prisma.Decimal | null;
}) {
  return {
    ...product,
    purchasePrice: product.purchasePrice.toFixed(2),
    sellingPrice: product.sellingPrice.toFixed(2),
    taxRate: product.taxRate.toFixed(2),
    minTemp: product.minTemp?.toFixed(2) ?? null,
    maxTemp: product.maxTemp?.toFixed(2) ?? null,
  };
}

export async function listProducts(auth: AuthContext, query: ProductListQuery) {
  const where: Prisma.ProductWhereInput = { companyId: auth.companyId };
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { code: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      ...paginate(query),
      orderBy: { [query.sortBy === 'name' ? 'name' : 'code']: query.sortOrder },
    }),
  ]);

  return { data: rows.map(serialize), meta: pageMeta(query, total) };
}

export async function getProduct(auth: AuthContext, id: string) {
  const product = await prisma.product.findFirst({
    where: { id, companyId: auth.companyId },
    include: {
      batches: {
        orderBy: { expiryDate: 'asc' },
        select: { id: true, batchNumber: true, expiryDate: true, status: true },
      },
    },
  });
  if (!product) {
    throw notFound('Product not found');
  }
  return { ...serialize(product), batches: product.batches };
}

export async function createProduct(auth: AuthContext, input: ProductInput) {
  const existing = await prisma.product.findFirst({
    where: { companyId: auth.companyId, code: input.code },
  });
  if (existing) {
    throw conflict('A product with code ' + input.code + ' already exists');
  }

  const product = await prisma.product.create({
    data: {
      companyId: auth.companyId,
      code: input.code,
      name: input.name,
      unit: input.unit,
      purchasePrice: money(input.purchasePrice),
      sellingPrice: money(input.sellingPrice),
      taxRate: money(input.taxRate),
      trackInventory: input.trackInventory ?? true,
      isActive: input.isActive ?? true,
      minTemp: input.minTemp ? money(input.minTemp) : null,
      maxTemp: input.maxTemp ? money(input.maxTemp) : null,
    },
  });
  return serialize(product);
}

/**
 * Products referenced by posted documents are never deleted; deactivating keeps
 * historical documents and stock movements intact.
 */
export async function updateProduct(auth: AuthContext, id: string, input: Partial<ProductInput>) {
  const product = await prisma.product.findFirst({
    where: { id, companyId: auth.companyId },
  });
  if (!product) {
    throw notFound('Product not found');
  }

  if (input.code && input.code !== product.code) {
    const duplicate = await prisma.product.findFirst({
      where: { companyId: auth.companyId, code: input.code, id: { not: id } },
    });
    if (duplicate) {
      throw conflict('A product with code ' + input.code + ' already exists');
    }
  }

  const data: Prisma.ProductUpdateInput = {};
  if (input.code !== undefined) data.code = input.code;
  if (input.name !== undefined) data.name = input.name;
  if (input.unit !== undefined) data.unit = input.unit;
  if (input.purchasePrice !== undefined) data.purchasePrice = money(input.purchasePrice);
  if (input.sellingPrice !== undefined) data.sellingPrice = money(input.sellingPrice);
  if (input.taxRate !== undefined) data.taxRate = money(input.taxRate);
  if (input.trackInventory !== undefined) data.trackInventory = input.trackInventory;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.minTemp !== undefined) data.minTemp = input.minTemp ? money(input.minTemp) : null;
  if (input.maxTemp !== undefined) data.maxTemp = input.maxTemp ? money(input.maxTemp) : null;

  return serialize(await prisma.product.update({ where: { id }, data }));
}
