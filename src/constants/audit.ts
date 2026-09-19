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
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];
