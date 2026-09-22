import { z } from 'zod';
import { AccountingEvent, AccountMappingType, JournalStatus } from '@prisma/client';
import { isoDate, paginationSchema, reasonText, uuid } from '../common';

export const initializeAccountingSchema = z.object({
  /** Defaults to the reporting format the deployment ships with. */
  templateKey: z.string().trim().min(2).max(40).optional(),
});
export type InitializeAccountingInput = z.infer<typeof initializeAccountingSchema>;

export const chartQuerySchema = z.object({
  natureCode: z.string().trim().max(10).optional(),
});
export type ChartQuery = z.infer<typeof chartQuerySchema>;

export const ledgerQuerySchema = z.object({
  headCode: z.string().trim().max(20).optional(),
  natureCode: z.string().trim().max(10).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const journalListQuerySchema = paginationSchema.extend({
  branchId: uuid.optional(),
  status: z.nativeEnum(JournalStatus).optional(),
  event: z.nativeEnum(AccountingEvent).optional(),
  sourceDocumentId: uuid.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});
export type JournalListQuery = z.infer<typeof journalListQuerySchema>;

export const reverseJournalSchema = z.object({ reason: reasonText });
export type ReverseJournalInput = z.infer<typeof reverseJournalSchema>;

export const generalLedgerQuerySchema = paginationSchema.extend({
  ledgerId: uuid,
  branchId: uuid.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});
export type GeneralLedgerQuery = z.infer<typeof generalLedgerQuerySchema>;

export const reportQuerySchema = z.object({
  branchId: uuid.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const mappingTypeParamSchema = z.object({
  mappingType: z.nativeEnum(AccountMappingType),
});
export type MappingTypeParam = z.infer<typeof mappingTypeParamSchema>;

export const resolveMappingQuerySchema = z.object({ branchId: uuid.optional() });
export type ResolveMappingQuery = z.infer<typeof resolveMappingQuerySchema>;

export const paymentIdParamSchema = z.object({ paymentId: uuid });
export type PaymentIdParam = z.infer<typeof paymentIdParamSchema>;

/**
 * The supplier filter is optional on purpose. Without it the ledger shows every
 * supplier's movement through the one payables control account, which is the view
 * that proves the subledger and the control account are the same rows.
 */
export const supplierLedgerQuerySchema = z.object({
  supplierId: uuid.optional(),
  branchId: uuid.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});
export type SupplierLedgerQuery = z.infer<typeof supplierLedgerQuerySchema>;

export const supplierOutstandingQuerySchema = z.object({
  supplierId: uuid.optional(),
  branchId: uuid.optional(),
});
export type SupplierOutstandingQuery = z.infer<typeof supplierOutstandingQuerySchema>;
