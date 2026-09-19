import { Request, Response } from 'express';
import * as notificationService from '../services/notification.service';
import { ok, okList } from '../handlers/response';
import { requireAuth } from '../context/authContext';
import { params, query } from '../middleware/validate';
import { IdParam } from '../schemas/common';
import { NotificationListQueryInput } from '../schemas/notification';

export const notificationController = {
  async list(req: Request, res: Response) {
    const result = await notificationService.getUserNotifications(
      requireAuth(req),
      query<NotificationListQueryInput>(req)
    );
    return okList(res, result.data, result.meta);
  },

  async unreadCount(req: Request, res: Response) {
    return ok(res, await notificationService.getUnreadCount(requireAuth(req)));
  },

  async markRead(req: Request, res: Response) {
    return ok(
      res,
      await notificationService.markAsRead(requireAuth(req), params<IdParam>(req).id)
    );
  },

  async markAllRead(req: Request, res: Response) {
    return ok(res, await notificationService.markAllAsRead(requireAuth(req)));
  },
};
