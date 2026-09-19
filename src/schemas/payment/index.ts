import { z } from 'zod';
import { PaymentMethod } from '@prisma/client';
import { isoDate, paginationSchema, positiveDecimal, uuid } from '../common';

export const allocationSchema = z.object({
  documentId: uuid,
  amount: positiveDecimal,
});

export const createPaymentSchema = z.object({
  supplierId: uuid,
  branchId: uuid,
  amount: positiveDecimal,
  method: z.nativeEnum(PaymentMethod),
  paymentDate: isoDate.optional(),
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(500).optional(),
  allocations: z.array(allocationSchema).max(50).optional(),
});
export type CreatePaymentBody = z.infer<typeof createPaymentSchema>;

export const allocatePaymentSchema = z.object({
  allocations: z.array(allocationSchema).min(1).max(50),
});
export type AllocatePaymentBody = z.infer<typeof allocatePaymentSchema>;

export const paymentListQuerySchema = paginationSchema.extend({
  supplierId: uuid.optional(),
  branchId: uuid.optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
