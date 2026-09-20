import { z } from 'zod';
import { isoDate, positiveDecimal, uuid } from '../common';

export const createTransferSchema = z
  .object({
    sourceBranchId: uuid,
    destinationBranchId: uuid,
    /** Business date the transfer is raised on. Defaults to now. */
    documentDate: isoDate.optional(),
    expectedDate: isoDate.optional(),
    notes: z.string().trim().max(500).optional(),
    /** Optional: the stock requirement this transfer is raised to help fulfil. */
    requirementId: uuid.optional(),
    lines: z
      .array(
        z.object({
          productId: uuid,
          batchId: uuid,
          quantity: positiveDecimal,
        })
      )
      .min(1)
      .max(200),
  })
  .refine(
    (v) => v.sourceBranchId !== v.destinationBranchId,
    'Source and destination branches must be different'
  );
export type CreateTransferBody = z.infer<typeof createTransferSchema>;
