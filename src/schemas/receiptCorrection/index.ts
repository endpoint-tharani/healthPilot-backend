import { z } from 'zod';
import { isoDate, nonNegativeDecimal, reasonText, uuid } from '../common';

export const createCorrectionSchema = z.object({
  goodsReceiptId: uuid,
  /** Business date the correction is raised on. Defaults to now. */
  documentDate: isoDate.optional(),
  reason: reasonText,
  lines: z
    .array(
      z.object({
        goodsReceiptLineItemId: uuid,
        correctedAcceptedQuantity: nonNegativeDecimal,
        correctedDamagedQuantity: nonNegativeDecimal,
        correctedMissingQuantity: nonNegativeDecimal,
      })
    )
    .min(1)
    .max(200),
});
export type CreateCorrectionBody = z.infer<typeof createCorrectionSchema>;
