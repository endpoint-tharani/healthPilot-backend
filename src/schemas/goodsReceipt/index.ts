import { z } from 'zod';
import { isoDate, nonNegativeDecimal, positiveDecimal, uuid } from '../common';

export const createGoodsReceiptSchema = z.object({
  purchaseOrderId: uuid,
  supplierRef: z.string().trim().min(1).max(100),
  receiptDate: isoDate.optional(),
  notes: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z
        .object({
          purchaseOrderLineItemId: uuid,
          quantity: positiveDecimal,
          acceptedQuantity: nonNegativeDecimal,
          damagedQuantity: nonNegativeDecimal,
          missingQuantity: nonNegativeDecimal,
          batchId: uuid.optional(),
          batchNumber: z.string().trim().min(1).max(60).optional(),
          expiryDate: isoDate.optional(),
          notes: z.string().trim().max(255).optional(),
        })
        .refine(
          (line) => Boolean(line.batchId) || Boolean(line.batchNumber && line.expiryDate),
          'Provide batchId, or batchNumber together with expiryDate'
        )
    )
    .min(1)
    .max(200),
});
export type CreateGoodsReceiptBody = z.infer<typeof createGoodsReceiptSchema>;
