export const AuditAction = {
  CREATE: 'CREATE',
  SUBMIT: 'SUBMIT',
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  POST: 'POST',
  CORRECT: 'CORRECT',
  DISPATCH: 'DISPATCH',
  RECEIVE: 'RECEIVE',
  CANCEL: 'CANCEL',
  PAYMENT_ALLOCATED: 'PAYMENT_ALLOCATED',
  FULFILMENT_UPDATED: 'FULFILMENT_UPDATED',
  /** Internal stock was allocated to a requirement by raising a transfer for it. */
  TRANSFER_ALLOCATED: 'TRANSFER_ALLOCATED',
  CREDIT_APPLIED: 'CREDIT_APPLIED',
  /** A supplier invoice was re-valued because the accepted quantity behind it changed. */
  DISPUTE_RECALCULATED: 'DISPUTE_RECALCULATED',
  /** A journal entry was raised for this document. */
  ACCOUNTING_POSTED: 'ACCOUNTING_POSTED',
  /** A journal entry raised for this document was reversed by a correcting entry. */
  ACCOUNTING_REVERSED: 'ACCOUNTING_REVERSED',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
