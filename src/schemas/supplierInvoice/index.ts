import { z } from 'zod';
import { isoDate, nonNegativeDecimal, percentDecimal, positiveDecimal, uuid } from '../common';

export const createInvoiceSchema = z.object({
  purchaseOrderId: uuid,
  supplierRef: z.string().trim().min(1).max(100),
  invoiceDate: isoDate.optional(),
  dueDate: isoDate.optional(),
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
export type CreateInvoiceBody = z.infer<typeof createInvoiceSchema>;
