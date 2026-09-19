import { z } from 'zod';
import { config } from '../../config/env';

export const uuid = z.string().uuid('Must be a valid id');

export const idParamSchema = z.object({ id: uuid });
export type IdParam = z.infer<typeof idParamSchema>;

export const branchIdParamSchema = z.object({ branchId: uuid });
export const productIdParamSchema = z.object({ productId: uuid });
export const batchIdParamSchema = z.object({ batchId: uuid });

/** Money and quantities arrive as strings or numbers and stay in Decimal from here on. */
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d{1,4})?$/.test(v), 'Must be a valid decimal number');

export const nonNegativeDecimal = decimalString.refine(
  (v) => Number(v) >= 0,
  'Must be zero or greater'
);

export const positiveDecimal = decimalString.refine((v) => Number(v) > 0, 'Must be greater than 0');

export const percentDecimal = decimalString.refine(
  (v) => Number(v) >= 0 && Number(v) <= 100,
  'Must be between 0 and 100'
);

export const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Must be a valid ISO date')
  .transform((v) => new Date(v));

export const booleanQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const entityCode = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, 'Code may contain letters, digits, dot, dash and underscore only');

export const entityName = z.string().trim().min(2).max(160);

export const reasonText = z.string().trim().min(3).max(500);
export const optionalReasonSchema = z.object({ reason: z.string().trim().max(500).optional() });
export const requiredReasonSchema = z.object({ reason: reasonText });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(config.maxPageSize).default(20),
  search: z.string().trim().min(1).max(200).optional(),
  sortBy: z.string().trim().max(50).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const documentListQuerySchema = paginationSchema.extend({
  status: z.string().trim().optional(),
  branchId: uuid.optional(),
  supplierId: uuid.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export function paginate(p: { page: number; limit: number }) {
  return { skip: (p.page - 1) * p.limit, take: p.limit };
}

export function pageMeta(p: { page: number; limit: number }, total: number) {
  return {
    page: p.page,
    limit: p.limit,
    total,
    totalPages: Math.ceil(total / p.limit) || 0,
  };
}
