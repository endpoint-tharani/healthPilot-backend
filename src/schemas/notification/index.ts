import { z } from 'zod';
import { NotificationType } from '@prisma/client';
import { booleanQuery, isoDate, paginationSchema } from '../common';

/**
 * Note what is absent: there is no recipientUserId and no companyId. The
 * recipient is always the authenticated user, so there is nothing a client could
 * send that would widen the query to somebody else's inbox.
 */
export const notificationListQuerySchema = paginationSchema.extend({
  unreadOnly: booleanQuery,
  type: z.nativeEnum(NotificationType).optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});

export type NotificationListQueryInput = z.infer<typeof notificationListQuerySchema>;
