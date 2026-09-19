import { z } from 'zod';
import { booleanQuery, entityCode, entityName, paginationSchema } from '../common';

export const supplierListQuerySchema = paginationSchema.extend({ isActive: booleanQuery });
export type SupplierListQuery = z.infer<typeof supplierListQuerySchema>;

export const createSupplierSchema = z.object({
  code: entityCode,
  name: entityName,
  contactInfo: z.string().trim().max(255).optional(),
  address: z.string().trim().max(255).optional(),
  isActive: z.boolean().optional(),
});
export type CreateSupplierBody = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = createSupplierSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
export type UpdateSupplierBody = z.infer<typeof updateSupplierSchema>;
