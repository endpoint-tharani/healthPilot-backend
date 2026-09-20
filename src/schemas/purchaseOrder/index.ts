import { z } from 'zod';
import { isoDate, nonNegativeDecimal, percentDecimal, positiveDecimal, uuid } from '../common';

export const createPurchaseOrderSchema = z.object({
  requirementId: uuid,
  supplierId: uuid,
  deliveryBranchId: uuid,
  /** Business date the order is raised on. Defaults to now. */
  documentDate: isoDate.optional(),
  expectedDeliveryDate: isoDate,
  notes: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        productId: uuid,
        quantity: positiveDecimal,
        unitPrice: nonNegativeDecimal.optional(),
        taxRate: percentDecimal.optional(),
      })
    )
    .min(1)
    .max(200),
});
export type CreatePurchaseOrderBody = z.infer<typeof createPurchaseOrderSchema>;
