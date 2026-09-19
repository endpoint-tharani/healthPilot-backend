import { z } from 'zod';
import {
  booleanQuery,
  entityCode,
  entityName,
  nonNegativeDecimal,
  paginationSchema,
  percentDecimal,
} from '../common';

export const productListQuerySchema = paginationSchema.extend({ isActive: booleanQuery });
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

export const createProductSchema = z.object({
  code: entityCode,
  name: entityName,
  unit: z.string().trim().min(1).max(30),
  purchasePrice: nonNegativeDecimal,
  sellingPrice: nonNegativeDecimal,
  taxRate: percentDecimal,
  trackInventory: z.boolean().optional(),
  isActive: z.boolean().optional(),
  minTemp: nonNegativeDecimal.nullable().optional(),
  maxTemp: nonNegativeDecimal.nullable().optional(),
});
export type CreateProductBody = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
export type UpdateProductBody = z.infer<typeof updateProductSchema>;
