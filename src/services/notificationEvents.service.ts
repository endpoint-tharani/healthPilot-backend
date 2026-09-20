import {
  DocumentStatus,
  NotificationEntityType,
  NotificationSeverity,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { AuthContext } from '../context/authContext';
import { Permission } from '../constants/permissions';
import { ZERO } from '../utils/decimal';
import { createNotifications, eventKey, NotificationDraft } from './notification.service';
import {
  mergeRecipients,
  resolveNamedRecipient,
  resolveRecipients,
} from './notificationRecipients.service';

/**
 * The catalogue of business events worth telling somebody about.
 *
 * Each function is called by its business service from inside the service's own
 * transaction, after the operation has already succeeded and passed every
 * validation. Nothing here changes business state, recalculates a figure or
 * re-decides a status: the numbers in the messages are the ones the caller has
 * just committed.
 *
 * Routine database writes get no notification. Only transitions a person is
 * expected to act on, or would be surprised not to hear about, appear below.
 */

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Matches the UI's money formatting, so the bell reads like the document. */
function money(value: Prisma.Decimal | string): string {
  return '₹' + inr.format(Number(new Prisma.Decimal(value).toFixed(2)));
}

/** Quantities lose a trailing .00, as they do everywhere else in the product. */
function qty(value: Prisma.Decimal): string {
  const rounded = value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return rounded.isInteger() ? rounded.toFixed(0) : rounded.toFixed(2);
}

interface DocumentRef {
  id: string;
  companyId: string;
  documentNumber: string;
  branchId?: string | null;
  sourceBranchId?: string | null;
  destinationBranchId?: string | null;
  createdById?: string;
}

/** Every draft points at a document, so clicking the alert opens the record. */
function draftsFor(
  recipients: string[],
  base: Omit<NotificationDraft, 'recipientUserId'>
): NotificationDraft[] {
  return recipients.map((recipientUserId) => ({ ...base, recipientUserId }));
}

function documentBase(
  doc: DocumentRef,
  branchId: string | null | undefined,
  fields: Pick<NotificationDraft, 'type' | 'title' | 'message' | 'severity' | 'eventKey'>
): Omit<NotificationDraft, 'recipientUserId'> {
  return {
    ...fields,
    entityType: NotificationEntityType.DOCUMENT,
    entityId: doc.id,
    documentId: doc.id,
    branchId: branchId ?? null,
  };
}

/* ------------------------------------------------------ stock requirements ---- */

/**
 * A branch has asked for stock. This is addressed to whoever may decide on it:
 * approvers whose scope covers the raising branch, plus central procurement, who
 * hold the central warehouse rather than that branch.
 */
export async function notifyRequirementSubmitted(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  requirement: DocumentRef,
  branchName: string
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.STOCK_REQUIREMENT_APPROVE],
      branchIds: requirement.branchId ? [requirement.branchId] : [],
      includeCentralWarehouse: true,
      excludeUserIds: [auth.userId],
    },
    tx
  );

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      documentBase(requirement, requirement.branchId, {
        type: NotificationType.STOCK_REQUIREMENT_SUBMITTED,
        title: 'New Stock Requisition',
        message: `${requirement.documentNumber} submitted by ${branchName}.`,
        severity: NotificationSeverity.INFO,
        eventKey: eventKey(NotificationType.STOCK_REQUIREMENT_SUBMITTED, requirement.id),
      })
    )
  );
}

/**
 * The decision goes back to the branch that raised it: the person who submitted
 * it, and anyone else at that branch who raises requirements.
 */
export async function notifyRequirementDecision(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  requirement: DocumentRef,
  decision: typeof DocumentStatus.APPROVED | typeof DocumentStatus.REJECTED,
  reason?: string | null
) {
  const branchTeam = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.STOCK_REQUIREMENT_CREATE],
      branchIds: requirement.branchId ? [requirement.branchId] : [],
      excludeUserIds: [auth.userId],
    },
    tx
  );
  const requester = await resolveNamedRecipient(
    auth.companyId,
    requirement.createdById,
    [Permission.STOCK_REQUIREMENT_VIEW],
    tx
  );

  const approved = decision === DocumentStatus.APPROVED;
  const type = approved
    ? NotificationType.STOCK_REQUIREMENT_APPROVED
    : NotificationType.STOCK_REQUIREMENT_REJECTED;

  const message = approved
    ? `${requirement.documentNumber} has been approved.`
    : `${requirement.documentNumber} was rejected${reason ? `: ${reason}.` : '.'}`;

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      mergeRecipients(auth.userId, branchTeam, requester),
      documentBase(requirement, requirement.branchId, {
        type,
        title: approved ? 'Stock Requisition Approved' : 'Stock Requisition Rejected',
        message,
        severity: approved ? NotificationSeverity.SUCCESS : NotificationSeverity.WARNING,
        eventKey: eventKey(type, requirement.id),
      })
    )
  );
}

export interface FulfilmentTotals {
  requested: Prisma.Decimal;
  received: Prisma.Decimal;
  remaining: Prisma.Decimal;
}

/**
 * Fulfilment moved. The figures are handed in by the fulfilment update that just
 * decided the status - this never re-derives them, so the bell can never disagree
 * with the document.
 *
 * `transition` is the count of fulfilment changes already recorded against the
 * requirement. It keeps the event key unique when a correction knocks a
 * requirement back to PARTIALLY_FULFILLED and a follow-up order fulfils it a
 * second time, while a replay of the same transition still de-duplicates.
 */
export async function notifyRequirementFulfilment(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  requirement: DocumentRef,
  status: DocumentStatus,
  totals: FulfilmentTotals,
  transition: number
) {
  const fulfilled = status === DocumentStatus.FULFILLED;
  const type = fulfilled
    ? NotificationType.STOCK_REQUIREMENT_FULFILLED
    : NotificationType.STOCK_REQUIREMENT_PARTIALLY_FULFILLED;

  const branchTeam = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.STOCK_REQUIREMENT_CREATE],
      branchIds: requirement.branchId ? [requirement.branchId] : [],
    },
    tx
  );
  // Procurement is told about a shortfall because covering it is their next move.
  const procurement = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.STOCK_REQUIREMENT_APPROVE],
      branchIds: requirement.branchId ? [requirement.branchId] : [],
      includeCentralWarehouse: true,
    },
    tx
  );
  const requester = await resolveNamedRecipient(
    auth.companyId,
    requirement.createdById,
    [Permission.STOCK_REQUIREMENT_VIEW],
    tx
  );

  const progress = `${qty(totals.received)}/${qty(totals.requested)} units`;
  const message = fulfilled
    ? `${requirement.documentNumber} is fully fulfilled: ${progress}.`
    : `${requirement.documentNumber} is partially fulfilled: ${progress}. ${qty(
        totals.remaining
      )} remaining.`;

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      mergeRecipients(auth.userId, branchTeam, procurement, requester),
      documentBase(requirement, requirement.branchId, {
        type,
        title: fulfilled ? 'Stock Requisition Fulfilled' : 'Stock Requisition Partially Fulfilled',
        message,
        severity: fulfilled ? NotificationSeverity.SUCCESS : NotificationSeverity.WARNING,
        eventKey: eventKey(type, requirement.id, transition),
      })
    )
  );
}

/* -------------------------------------------------------- purchase orders ---- */

export async function notifyPurchaseOrderCreated(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  order: DocumentRef,
  requirementNumber: string,
  supplierName: string
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.PURCHASE_ORDER_APPROVE],
      branchIds: order.branchId ? [order.branchId] : [],
      includeCentralWarehouse: true,
      excludeUserIds: [auth.userId],
    },
    tx
  );

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      documentBase(order, order.branchId, {
        type: NotificationType.PURCHASE_ORDER_CREATED,
        title: 'Purchase Order Raised',
        message: `${order.documentNumber} raised on ${supplierName} against ${requirementNumber}.`,
        severity: NotificationSeverity.INFO,
        eventKey: eventKey(NotificationType.PURCHASE_ORDER_CREATED, order.id),
      })
    )
  );
}

/** Approval is the signal to the delivery branch that goods may now be received. */
export async function notifyPurchaseOrderApproved(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  order: DocumentRef,
  supplierName: string
) {
  const receivers = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.GOODS_RECEIPT_CREATE],
      branchIds: order.branchId ? [order.branchId] : [],
      includeCentralWarehouse: true,
    },
    tx
  );
  const raiser = await resolveNamedRecipient(
    auth.companyId,
    order.createdById,
    [Permission.PURCHASE_ORDER_VIEW],
    tx
  );

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      mergeRecipients(auth.userId, receivers, raiser),
      documentBase(order, order.branchId, {
        type: NotificationType.PURCHASE_ORDER_APPROVED,
        title: 'Purchase Order Approved',
        message: `${order.documentNumber} to ${supplierName} has been approved.`,
        severity: NotificationSeverity.SUCCESS,
        eventKey: eventKey(NotificationType.PURCHASE_ORDER_APPROVED, order.id),
      })
    )
  );
}

/* ---------------------------------------------------------- goods receipts ---- */

export interface ReceiptTotals {
  accepted: Prisma.Decimal;
  damaged: Prisma.Decimal;
  missing: Prisma.Decimal;
}

export async function notifyGoodsReceiptPosted(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  receipt: DocumentRef,
  orderNumber: string,
  totals: ReceiptTotals
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.GOODS_RECEIPT_VIEW],
      branchIds: receipt.branchId ? [receipt.branchId] : [],
      includeCentralWarehouse: true,
      excludeUserIds: [auth.userId],
    },
    tx
  );

  const shortfall = totals.damaged.plus(totals.missing);
  const message = shortfall.greaterThan(0)
    ? `${receipt.documentNumber} posted against ${orderNumber}: ${qty(
        totals.accepted
      )} accepted, ${qty(totals.damaged)} damaged, ${qty(totals.missing)} missing.`
    : `${receipt.documentNumber} posted against ${orderNumber}: ${qty(
        totals.accepted
      )} accepted into stock.`;

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      documentBase(receipt, receipt.branchId, {
        type: NotificationType.GOODS_RECEIPT_POSTED,
        title: 'Goods Receipt Posted',
        message,
        // A receipt that arrived short is a warning; a clean one is good news.
        severity: shortfall.greaterThan(0)
          ? NotificationSeverity.WARNING
          : NotificationSeverity.SUCCESS,
        eventKey: eventKey(NotificationType.GOODS_RECEIPT_POSTED, receipt.id),
      })
    )
  );
}

export interface CorrectionSummary {
  before: ReceiptTotals;
  after: ReceiptTotals;
}

/**
 * A correction restates what a posted receipt really contained, which changes
 * both the stock position and what is still owed to the branch. The message
 * carries the before and after so the reader does not have to open the document
 * to know how bad it is.
 */
export async function notifyReceiptCorrected(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  correction: DocumentRef,
  receipt: { id: string; documentNumber: string; createdById: string },
  summary: CorrectionSummary,
  reason: string
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.GOODS_RECEIPT_VIEW],
      branchIds: correction.branchId ? [correction.branchId] : [],
      includeCentralWarehouse: true,
      excludeUserIds: [auth.userId],
    },
    tx
  );
  const originalReceiver = await resolveNamedRecipient(
    auth.companyId,
    receipt.createdById,
    [Permission.GOODS_RECEIPT_VIEW],
    tx
  );

  const changes = [
    `Accepted ${qty(summary.before.accepted)} → ${qty(summary.after.accepted)}`,
    `Damaged ${qty(summary.before.damaged)} → ${qty(summary.after.damaged)}`,
    `Missing ${qty(summary.before.missing)} → ${qty(summary.after.missing)}`,
  ].join(', ');

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      mergeRecipients(auth.userId, recipients, originalReceiver),
      // Linked to the correction document, which is where the detail lives.
      documentBase(correction, correction.branchId, {
        type: NotificationType.GOODS_RECEIPT_CORRECTED,
        title: 'Receipt Corrected',
        message: `${receipt.documentNumber} was corrected. ${changes}. Reason: ${reason}`,
        severity: NotificationSeverity.INFO,
        eventKey: eventKey(NotificationType.GOODS_RECEIPT_CORRECTED, correction.id),
      })
    )
  );
}

/* ------------------------------------------------------- supplier invoices ---- */

export async function notifySupplierInvoiceCreated(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  invoice: DocumentRef,
  supplierName: string,
  totalAmount: Prisma.Decimal,
  disputedAmount: Prisma.Decimal
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.SUPPLIER_INVOICE_VIEW],
      branchIds: invoice.branchId ? [invoice.branchId] : [],
      includeCentralWarehouse: true,
      excludeUserIds: [auth.userId],
    },
    tx
  );

  const disputed = disputedAmount.greaterThan(0);
  const type = disputed
    ? NotificationType.SUPPLIER_INVOICE_DISPUTED
    : NotificationType.SUPPLIER_INVOICE_CREATED;

  const message = disputed
    ? `${invoice.documentNumber} from ${supplierName} for ${money(
        totalAmount
      )} carries ${money(disputedAmount)} the receipts did not accept.`
    : `${invoice.documentNumber} from ${supplierName} for ${money(totalAmount)} was booked.`;

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      documentBase(invoice, invoice.branchId, {
        type,
        title: disputed ? 'Supplier Invoice In Dispute' : 'Supplier Invoice Booked',
        message,
        severity: disputed ? NotificationSeverity.WARNING : NotificationSeverity.INFO,
        eventKey: eventKey(type, invoice.id),
      })
    )
  );
}

export async function notifyCreditNotePosted(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  creditNote: DocumentRef,
  invoiceNumber: string,
  amount: Prisma.Decimal
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.CREDIT_NOTE_VIEW],
      branchIds: creditNote.branchId ? [creditNote.branchId] : [],
      includeCentralWarehouse: true,
      excludeUserIds: [auth.userId],
    },
    tx
  );

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      documentBase(creditNote, creditNote.branchId, {
        type: NotificationType.CREDIT_NOTE_POSTED,
        title: 'Credit Note Posted',
        message: `${creditNote.documentNumber} of ${money(amount)} was raised against ${invoiceNumber}.`,
        severity: NotificationSeverity.SUCCESS,
        eventKey: eventKey(NotificationType.CREDIT_NOTE_POSTED, creditNote.id),
      })
    )
  );
}

/* ---------------------------------------------------------------- payments ---- */

/**
 * Allocation carries the payment reference, the amount and the invoice it
 * settled. Nothing else about the payment is exposed - no method, no bank
 * reference, no supplier account detail.
 */
export async function notifyPaymentAllocated(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  payment: { id: string; paymentNumber: string; branchId: string | null },
  invoice: DocumentRef,
  allocatedAmount: Prisma.Decimal
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.PAYMENT_VIEW],
      branchIds: [payment.branchId, invoice.branchId].filter((id): id is string => Boolean(id)),
      includeCentralWarehouse: true,
      excludeUserIds: [auth.userId],
    },
    tx
  );

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      // The invoice is the useful destination: it shows the allocation in place.
      documentBase(invoice, invoice.branchId, {
        type: NotificationType.PAYMENT_ALLOCATED,
        title: 'Payment Allocated',
        message: `Payment ${payment.paymentNumber} of ${money(allocatedAmount)} was allocated to ${invoice.documentNumber}.`,
        severity: NotificationSeverity.SUCCESS,
        eventKey: eventKey(
          NotificationType.PAYMENT_ALLOCATED,
          invoice.id,
          payment.id,
          allocatedAmount.toFixed(2)
        ),
      })
    )
  );
}

/* --------------------------------------------------------- stock transfers ---- */

export async function notifyTransferCreated(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  transfer: DocumentRef,
  sourceName: string,
  destinationName: string,
  requirementNumber?: string
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.STOCK_TRANSFER_VIEW],
      branchIds: [transfer.sourceBranchId, transfer.destinationBranchId].filter(
        (id): id is string => Boolean(id)
      ),
      excludeUserIds: [auth.userId],
    },
    tx
  );

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      documentBase(transfer, transfer.destinationBranchId, {
        type: NotificationType.STOCK_TRANSFER_CREATED,
        title: 'Stock Transfer Raised',
        // Naming the requirement tells the source branch why they are being asked
        // to give stock up, which is the difference between an internal sourcing
        // decision and an unexplained one.
        message: requirementNumber
          ? `${transfer.documentNumber} raised from ${sourceName} to ${destinationName} for ${requirementNumber}.`
          : `${transfer.documentNumber} raised from ${sourceName} to ${destinationName}.`,
        severity: NotificationSeverity.INFO,
        eventKey: eventKey(NotificationType.STOCK_TRANSFER_CREATED, transfer.id),
      })
    )
  );
}

/** Dispatch is aimed at the destination: stock is in transit towards them. */
export async function notifyTransferDispatched(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  transfer: DocumentRef,
  sourceName: string,
  destinationName: string,
  requirementNumber?: string
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.STOCK_TRANSFER_RECEIVE],
      branchIds: transfer.destinationBranchId ? [transfer.destinationBranchId] : [],
      excludeUserIds: [auth.userId],
    },
    tx
  );

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      documentBase(transfer, transfer.destinationBranchId, {
        type: NotificationType.STOCK_TRANSFER_DISPATCHED,
        title: 'Stock Transfer Dispatched',
        message: requirementNumber
          ? `${transfer.documentNumber} dispatched from ${sourceName} to ${destinationName} for ${requirementNumber}.`
          : `${transfer.documentNumber} dispatched from ${sourceName} to ${destinationName}.`,
        severity: NotificationSeverity.INFO,
        eventKey: eventKey(NotificationType.STOCK_TRANSFER_DISPATCHED, transfer.id),
      })
    )
  );
}

/** Receipt closes the loop, so both ends are told. */
export async function notifyTransferReceived(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  transfer: DocumentRef,
  destinationName: string,
  requirementNumber?: string
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.STOCK_TRANSFER_VIEW],
      branchIds: [transfer.sourceBranchId, transfer.destinationBranchId].filter(
        (id): id is string => Boolean(id)
      ),
      excludeUserIds: [auth.userId],
    },
    tx
  );

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      documentBase(transfer, transfer.destinationBranchId, {
        type: NotificationType.STOCK_TRANSFER_RECEIVED,
        title: 'Stock Transfer Received',
        message: requirementNumber
          ? `${transfer.documentNumber} received by ${destinationName} for ${requirementNumber}.`
          : `${transfer.documentNumber} received by ${destinationName}.`,
        severity: NotificationSeverity.SUCCESS,
        eventKey: eventKey(NotificationType.STOCK_TRANSFER_RECEIVED, transfer.id),
      })
    )
  );
}

/* -------------------------------------------------------------- dispensing ---- */

/**
 * Dispensing is high volume, so this stays inside the dispensing branch: only
 * users who hold dispensing at that branch hear about it, never the whole
 * company.
 */
export async function notifyDispensingCompleted(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  dispensing: DocumentRef,
  totalAmount: Prisma.Decimal,
  lineCount: number
) {
  const recipients = await resolveRecipients(
    {
      companyId: auth.companyId,
      permissions: [Permission.DISPENSING_VIEW],
      branchIds: dispensing.branchId ? [dispensing.branchId] : [],
      excludeUserIds: [auth.userId],
    },
    tx
  );

  return createNotifications(
    tx,
    auth.companyId,
    draftsFor(
      recipients,
      documentBase(dispensing, dispensing.branchId, {
        type: NotificationType.DISPENSING_COMPLETED,
        title: 'Dispensing Completed',
        message: `${dispensing.documentNumber} dispensed ${lineCount} ${
          lineCount === 1 ? 'item' : 'items'
        } for ${money(totalAmount)}.`,
        severity: NotificationSeverity.SUCCESS,
        eventKey: eventKey(NotificationType.DISPENSING_COMPLETED, dispensing.id),
      })
    )
  );
}

/** Summing helper shared by the receipt events. */
export function sumReceiptTotals(
  lines: {
    acceptedQuantity: Prisma.Decimal | null;
    damagedQuantity: Prisma.Decimal | null;
    missingQuantity: Prisma.Decimal | null;
  }[]
): ReceiptTotals {
  return lines.reduce<ReceiptTotals>(
    (acc, line) => ({
      accepted: acc.accepted.plus(line.acceptedQuantity ?? ZERO),
      damaged: acc.damaged.plus(line.damagedQuantity ?? ZERO),
      missing: acc.missing.plus(line.missingQuantity ?? ZERO),
    }),
    { accepted: ZERO, damaged: ZERO, missing: ZERO }
  );
}
