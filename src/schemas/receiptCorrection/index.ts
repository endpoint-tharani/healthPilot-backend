import { z } from 'zod';
import { nonNegativeDecimal, reasonText, uuid } from '../common';

export const createCorrectionSchema = z.object({
  goodsReceiptId: uuid,
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
