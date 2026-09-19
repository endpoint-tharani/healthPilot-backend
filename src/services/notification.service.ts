import {
  Notification,
  NotificationEntityType,
  NotificationSeverity,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { prisma } from '../database/prisma';
import { AuthContext } from '../context/authContext';
import { notFound } from '../utils/errors';
import { Pagination, pageMeta, paginate } from '../schemas/common';
import { emitRead, emitReadAll, emitNotifications } from '../realtime/notificationGateway';
import { enqueueNotifications, notifyingTransaction } from './notificationOutbox';

export { notifyingTransaction };

/**
 * The single place a notification is created.
 *
 * Business services describe the event and who should hear about it; nothing
 * writes to the Notification table directly and no controller creates one. Every
 * write happens inside the caller's transaction, so an alert cannot outlive a
 * business operation that rolled back.
 */
export interface NotificationDraft {
  recipientUserId: string;
  type: NotificationType;
  title: string;
  message: string;
  severity?: NotificationSeverity;
  entityType?: NotificationEntityType;
  entityId?: string | null;
  documentId?: string | null;
  branchId?: string | null;
  /**
   * Deterministic identity of this event for this recipient. Replaying the same
   * event - a retried request, a second call to the same method - writes nothing
   * the second time. Include a version component whenever the same type can
   * legitimately fire again for the same entity.
   */
  eventKey: string;
}

/** TYPE:entityId, plus any version that makes a legitimate repeat distinct. */
export function eventKey(
  type: NotificationType,
  entityId: string,
  ...version: (string | number)[]
): string {
  return [type, entityId, ...version.map(String)].join(':');
}

/**
 * Writes notifications inside the caller's transaction and parks the created
 * rows for delivery after it commits.
 *
 * skipDuplicates against the (companyId, recipientUserId, eventKey) unique index
 * is the duplicate guard: a replayed event inserts nothing and therefore emits
 * nothing, so a refreshed page or a repeated call can never produce ten
 * identical alerts.
 */
export async function createNotifications(
  tx: Prisma.TransactionClient,
  companyId: string,
  drafts: NotificationDraft[]
): Promise<Notification[]> {
  if (drafts.length === 0) {
    return [];
  }

  // Two rules resolving to the same recipient for the same event would collide on
  // the unique index inside one statement, so the batch is de-duplicated first.
  const unique = new Map<string, NotificationDraft>();
  for (const draft of drafts) {
    unique.set(draft.recipientUserId + '|' + draft.eventKey, draft);
  }

  const rows = await tx.notification.createManyAndReturn({
    data: [...unique.values()].map((draft) => ({
      companyId,
      recipientUserId: draft.recipientUserId,
      type: draft.type,
      title: draft.title,
      message: draft.message,
      severity: draft.severity ?? NotificationSeverity.INFO,
      entityType: draft.entityType ?? null,
      entityId: draft.entityId ?? null,
      documentId: draft.documentId ?? null,
      branchId: draft.branchId ?? null,
      eventKey: draft.eventKey,
    })),
    skipDuplicates: true,
  });

  enqueueNotifications(tx, rows);
  return rows;
}

/** Single-recipient convenience over createNotifications. */
export function createNotification(
  tx: Prisma.TransactionClient,
  companyId: string,
  draft: NotificationDraft
): Promise<Notification[]> {
  return createNotifications(tx, companyId, [draft]);
}

/* --------------------------------------------------------------- reading ---- */

export interface NotificationListQuery extends Pagination {
  unreadOnly?: boolean;
  type?: NotificationType;
  fromDate?: Date;
  toDate?: Date;
}

const NOTIFICATION_DISPLAY_INCLUDE = {
  document: { select: { id: true, documentNumber: true, documentType: true, status: true } },
  branch: { select: { id: true, code: true, name: true } },
} satisfies Prisma.NotificationInclude;

type NotificationRow = Prisma.NotificationGetPayload<{
  include: typeof NOTIFICATION_DISPLAY_INCLUDE;
}>;

/** The shape the API hands to the client. */
export function serializeNotification(row: NotificationRow) {
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
    isRead: row.isRead,
    readAt: row.readAt,
    createdAt: row.createdAt,
    document: row.document,
    branch: row.branch,
  };
}

/**
 * The signed-in user's own notifications, newest first.
 *
 * The recipient is always the authenticated user: there is no parameter that can
 * widen this to anybody else, so no request can read another user's inbox.
 */
export async function getUserNotifications(auth: AuthContext, query: NotificationListQuery) {
  const where: Prisma.NotificationWhereInput = {
    recipientUserId: auth.userId,
    companyId: auth.companyId,
  };

  if (query.unreadOnly) {
    where.isRead = false;
  }
  if (query.type) {
    where.type = query.type;
  }
  if (query.search) {
    where.OR = [
      { title: { contains: query.search, mode: 'insensitive' } },
      { message: { contains: query.search, mode: 'insensitive' } },
      { document: { documentNumber: { contains: query.search, mode: 'insensitive' } } },
    ];
  }
  if (query.fromDate || query.toDate) {
    where.createdAt = {
      ...(query.fromDate ? { gte: query.fromDate } : {}),
      ...(query.toDate ? { lte: query.toDate } : {}),
    };
  }

  const [total, unread, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({
      where: { recipientUserId: auth.userId, companyId: auth.companyId, isRead: false },
    }),
    prisma.notification.findMany({
      where,
      ...paginate(query),
      orderBy: { createdAt: 'desc' },
      include: NOTIFICATION_DISPLAY_INCLUDE,
    }),
  ]);

  return {
    data: rows.map(serializeNotification),
    meta: { ...pageMeta(query, total), unread },
  };
}

export async function getUnreadCount(auth: AuthContext): Promise<{ unread: number }> {
  const unread = await prisma.notification.count({
    where: { recipientUserId: auth.userId, companyId: auth.companyId, isRead: false },
  });
  return { unread };
}

/**
 * Marks one notification read. The update is scoped to the caller, so a request
 * naming somebody else's notification id changes nothing and answers 404 rather
 * than confirming that the id exists.
 */
export async function markAsRead(auth: AuthContext, id: string) {
  const result = await prisma.notification.updateMany({
    where: { id, recipientUserId: auth.userId, companyId: auth.companyId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });

  const row = await prisma.notification.findFirst({
    where: { id, recipientUserId: auth.userId, companyId: auth.companyId },
    include: NOTIFICATION_DISPLAY_INCLUDE,
  });
  if (!row) {
    throw notFound('Notification not found');
  }

  const { unread } = await getUnreadCount(auth);
  // Already-read rows are not re-broadcast, so a second click costs the other
  // tabs nothing.
  if (result.count > 0) {
    emitRead(auth.userId, row.id, unread);
  }

  return { notification: serializeNotification(row), unread };
}

export async function markAllAsRead(auth: AuthContext) {
  const result = await prisma.notification.updateMany({
    where: { recipientUserId: auth.userId, companyId: auth.companyId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });

  if (result.count > 0) {
    emitReadAll(auth.userId);
  }
  return { updated: result.count, unread: 0 };
}

/** Publishes a committed batch. Passed to notifyingTransaction by callers. */
export function deliverNotifications(rows: Notification[]): void {
  emitNotifications(rows);
}
