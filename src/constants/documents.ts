import { DocumentStatus, DocumentType } from '@prisma/client';

export const DOCUMENT_NUMBER_PREFIX: Record<DocumentType, string> = {
  STOCK_REQUIREMENT: 'REQ',
  PURCHASE_ORDER: 'PO',
  GOODS_RECEIPT: 'GRN',
  RECEIPT_CORRECTION: 'COR',
  SUPPLIER_INVOICE: 'INV',
  CREDIT_NOTE: 'CN',
  STOCK_TRANSFER: 'TRF',
  DISPENSING: 'DSP',
};

export const PAYMENT_NUMBER_PREFIX = 'PAY';
export const DOCUMENT_SEQUENCE_WIDTH = 4;

/** Statuses after which a document belongs to the accounting record and is frozen. */
export const IMMUTABLE_DOCUMENT_STATUSES: DocumentStatus[] = [
  DocumentStatus.POSTED,
  DocumentStatus.CORRECTED,
  DocumentStatus.DISPATCHED,
  DocumentStatus.RECEIVED,
  DocumentStatus.COMPLETED,
  DocumentStatus.PAID,
  DocumentStatus.CANCELLED,
  DocumentStatus.DISCREPANT,
];

/**
 * Stock requirements are raised by a branch but addressed to central procurement,
 * and the resulting purchase order may name any delivery branch. Users holding the
 * central warehouse in scope may therefore READ these two document types
 * company-wide. It never grants them the right to transact at another branch.
 */
export const CENTRAL_PROCUREMENT_READ_TYPES: DocumentType[] = [
  DocumentType.STOCK_REQUIREMENT,
  DocumentType.PURCHASE_ORDER,
];

export const SORTABLE_DOCUMENT_FIELDS = new Set([
  'documentNumber',
  'documentDate',
  'status',
  'totalAmount',
  'createdAt',
]);
