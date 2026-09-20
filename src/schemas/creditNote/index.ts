import { z } from 'zod';
import { isoDate, nonNegativeDecimal, percentDecimal, positiveDecimal, reasonText, uuid } from '../common';

export const createCreditNoteSchema = z.object({
  supplierInvoiceId: uuid,
  /** Business date of the credit note. Defaults to now. */
  documentDate: isoDate.optional(),
  supplierRef: z.string().trim().max(100).optional(),
  reason: reasonText,
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
export type CreateCreditNoteBody = z.infer<typeof createCreditNoteSchema>;
