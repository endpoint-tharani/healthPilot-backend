import { NotificationSeverity, NotificationType } from '@prisma/client';

export { NotificationType, NotificationSeverity };

/**
 * Whether a type is loud enough to interrupt the user with a toast on arrival.
 * Everything still reaches the bell; this only decides what also gets a snackbar,
 * so a busy central procurement user is not toasted for every routine posting.
 */
export const TOASTABLE_NOTIFICATION_TYPES: NotificationType[] = [
  NotificationType.STOCK_REQUIREMENT_SUBMITTED,
  NotificationType.STOCK_REQUIREMENT_APPROVED,
  NotificationType.STOCK_REQUIREMENT_REJECTED,
  NotificationType.STOCK_REQUIREMENT_PARTIALLY_FULFILLED,
  NotificationType.STOCK_REQUIREMENT_FULFILLED,
  NotificationType.PURCHASE_ORDER_APPROVED,
  NotificationType.GOODS_RECEIPT_CORRECTED,
  NotificationType.SUPPLIER_INVOICE_DISPUTED,
  NotificationType.STOCK_TRANSFER_DISPATCHED,
  NotificationType.STOCK_TRANSFER_RECEIVED,
  NotificationType.LOW_STOCK,
  NotificationType.EXPIRY_ALERT,
];

/** Newest-first history page size ceiling for the notification list endpoint. */
export const NOTIFICATION_MAX_PAGE_SIZE = 100;

/** Socket.IO event names. Kept in one place so the client cannot drift. */
export const SocketEvent = {
  /** Server -> client: a notification was created for this user. */
  NEW: 'notification:new',
  /** Server -> client: this user read one notification (multi-tab sync). */
  READ: 'notification:read',
  /** Server -> client: this user read everything (multi-tab sync). */
  READ_ALL: 'notification:read-all',
} as const;

export const SOCKET_PATH = '/socket.io';
