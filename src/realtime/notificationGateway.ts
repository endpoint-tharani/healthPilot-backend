import { Notification } from '@prisma/client';
import { logger } from '../loggers';
import { SocketEvent } from '../constants/notifications';
import { getSocketServer, room } from './socketServer';

/**
 * The payload a connected client receives. Only display and navigation fields
 * cross the wire: no tokens, no credentials, no recipient list, nothing about
 * other users or other branches.
 */
export interface NotificationEvent {
  id: string;
  type: Notification['type'];
  title: string;
  message: string;
  severity: Notification['severity'];
  entityType: Notification['entityType'];
  entityId: string | null;
  documentId: string | null;
  branchId: string | null;
  createdAt: Date;
  isRead: boolean;
}

export function toNotificationEvent(row: Notification): NotificationEvent {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    severity: row.severity,
    entityType: row.entityType,
    entityId: row.entityId,
    documentId: row.documentId,
    branchId: row.branchId,
    createdAt: row.createdAt,
    isRead: row.isRead,
  };
}

/**
 * Pushes committed notifications to whichever of the recipient's tabs are
 * connected. Delivery is addressed to the recipient's own room, so isolation is
 * structural rather than something each caller has to remember.
 *
 * Realtime is a convenience only: a recipient who is offline, or whose socket
 * drops mid-emit, still has the row waiting in PostgreSQL at next login.
 */
export function emitNotifications(rows: Notification[]): void {
  if (rows.length === 0) {
    return;
  }
  const io = getSocketServer();
  if (!io) {
    return;
  }

  try {
    for (const rowcopy of rows) {
      io.to(room.user(rowcopy.recipientUserId)).emit(
        SocketEvent.NEW,
        toNotificationEvent(rowcopy)
      );
    }
  } catch (error) {
    // The business transaction has already committed and the rows are stored:
    // a delivery failure must never be reported as a failed operation.
    logger.warn('Realtime notification delivery failed', {
      count: rows.length,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Multi-tab read sync: every other tab of the same user follows along. */
export function emitRead(userId: string, notificationId: string, unreadCount: number): void {
  getSocketServer()?.to(room.user(userId)).emit(SocketEvent.READ, { notificationId, unreadCount });
}

export function emitReadAll(userId: string): void {
  getSocketServer()?.to(room.user(userId)).emit(SocketEvent.READ_ALL, { unreadCount: 0 });
}
