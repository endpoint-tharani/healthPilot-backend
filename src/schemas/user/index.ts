import { z } from 'zod';
import { BranchScopeType, UserRole } from '@prisma/client';
import { booleanQuery, entityName, paginationSchema, uuid } from '../common';

export const userListQuerySchema = paginationSchema.extend({
  role: z.nativeEnum(UserRole).optional(),
  isActive: booleanQuery,
  branchId: uuid.optional(),
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: entityName,
  password: z.string().min(8).max(128),
  role: z.nativeEnum(UserRole),
  branchScope: z.nativeEnum(BranchScopeType),
  branchId: uuid.nullable().optional(),
  branchIds: z.array(uuid).max(50).optional(),
  isActive: z.boolean().optional(),
});
export type CreateUserBody = z.infer<typeof createUserSchema>;

export const updateUserSchema = createUserSchema
  .partial()
  .omit({ email: true })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');
export type UpdateUserBody = z.infer<typeof updateUserSchema>;
