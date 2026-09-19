import { z } from 'zod';
import { PaymentMethod } from '@prisma/client';
import { nonNegativeDecimal, positiveDecimal, uuid } from '../common';

export const createDispensingSchema = z.object({
  branchId: uuid,
  patientRef: z.string().trim().min(1, 'Patient reference is required').max(100),
  prescriptionRef: z.string().trim().min(1, 'Prescription reference is required').max(100),
  paymentMethod: z.nativeEnum(PaymentMethod),
  notes: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        productId: uuid,
        batchId: uuid,
        quantity: positiveDecimal,
        unitPrice: nonNegativeDecimal.optional(),
      })
    )
    .min(1)
    .max(100),
});
export type CreateDispensingBody = z.infer<typeof createDispensingSchema>;
