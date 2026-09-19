import { z } from 'zod';
import { isoDate, positiveDecimal, reasonText, uuid } from '../common';

export const createRequirementSchema = z.object({
  branchId: uuid,
  requiredDate: isoDate,
  reason: reasonText,
  lines: z
    .array(
      z.object({
        productId: uuid,
        quantity: positiveDecimal,
        notes: z.string().trim().max(255).optional(),
      })
    )
    .min(1, 'At least one line is required')
    .max(200),
});
export type CreateRequirementBody = z.infer<typeof createRequirementSchema>;
