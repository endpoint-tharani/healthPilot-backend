import { z } from 'zod';
import { BranchType } from '@prisma/client';
import { entityCode, entityName } from '../common';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Must be a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});
export type LoginBody = z.infer<typeof loginSchema>;

/**
 * Signup sets the password that will guard a whole new tenant, so it applies a
 * stricter policy than login, which only has to accept whatever was set before.
 */
const newPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a number');

export const signupBranchSchema = z.object({
  code: entityCode,
  name: entityName,
  type: z.nativeEnum(BranchType),
  address: z.string().trim().max(255).optional(),
});
export type SignupBranch = z.infer<typeof signupBranchSchema>;

export const signupSchema = z
  .object({
    company: z.object({
      name: entityName,
      /** Optional: derived from the company name when the caller does not pick one. */
      code: entityCode.optional(),
    }),
    admin: z.object({
      name: entityName,
      email: z.string().trim().toLowerCase().email('Must be a valid email'),
      password: newPassword,
    }),
    /**
     * A pharmacy network is only workable once it has somewhere to receive goods
     * and somewhere to dispense them, so the warehouse is required up front and
     * the rest of the branches can be added here or later.
     */
    branches: z.array(signupBranchSchema).min(1, 'At least one branch is required').max(20),
  })
  .superRefine((value, ctx) => {
    const warehouses = value.branches.filter((b) => b.type === BranchType.CENTRAL_WAREHOUSE);
    if (warehouses.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['branches'],
        message: 'Exactly one branch must be the central pharmacy warehouse',
      });
    }

    const codes = value.branches.map((b) => b.code.toUpperCase());
    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['branches'],
        message: 'Branch codes must be unique',
      });
    }
  });
export type SignupBody = z.infer<typeof signupSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(32, 'Invalid refresh token'),
});
export type RefreshBody = z.infer<typeof refreshSchema>;

export const logoutSchema = z.object({
  refreshToken: z.string().min(32, 'Invalid refresh token'),
  allSessions: z.boolean().optional(),
});
export type LogoutBody = z.infer<typeof logoutSchema>;
