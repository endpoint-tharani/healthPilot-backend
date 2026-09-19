import { z } from 'zod';
import { BranchType } from '@prisma/client';
import { booleanQuery, entityCode, entityName, paginationSchema } from '../common';

export const branchListQuerySchema = paginationSchema.extend({
  type: z.nativeEnum(BranchType).optional(),
  isActive: booleanQuery,
  /**
   * 'scope' selects the branches the caller may operate in (default). 'company'
   * lists every branch in the company and is only needed to name a transfer
   * destination, which by design may sit outside the caller's own scope.
   */
  scope: z.enum(['scope', 'company']).default('scope'),
});
export type BranchListQuery = z.infer<typeof branchListQuerySchema>;

export const createBranchSchema = z.object({
  code: entityCode,
  name: entityName,
  type: z.nativeEnum(BranchType),
  address: z.string().trim().max(255).optional(),
  isActive: z.boolean().optional(),
});
export type CreateBranchBody = z.infer<typeof createBranchSchema>;

export const updateBranchSchema = createBranchSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
export type UpdateBranchBody = z.infer<typeof updateBranchSchema>;
