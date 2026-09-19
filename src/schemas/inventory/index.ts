import { z } from 'zod';
import { InventoryTransactionType, StockStatus } from '@prisma/client';
import { isoDate, paginationSchema, uuid } from '../common';

export const stockQuerySchema = z.object({
  branchId: uuid.optional(),
  productId: uuid.optional(),
  batchId: uuid.optional(),
  stockStatus: z.nativeEnum(StockStatus).optional(),
});
export type StockQuery = z.infer<typeof stockQuerySchema>;

export const ledgerQuerySchema = paginationSchema.extend({
  branchId: uuid.optional(),
  productId: uuid.optional(),
  batchId: uuid.optional(),
  stockStatus: z.nativeEnum(StockStatus).optional(),
  transactionType: z.nativeEnum(InventoryTransactionType).optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;
