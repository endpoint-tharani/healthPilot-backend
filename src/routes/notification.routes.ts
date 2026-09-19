import { Router } from 'express';
import { notificationController } from '../controller/notification.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { validateParams, validateQuery } from '../middleware/validate';
import { idParamSchema } from '../schemas/common';
import { notificationListQuerySchema } from '../schemas/notification';

const router = Router();

/**
 * No permission middleware here on purpose. A notification is not a business
 * record a role is granted access to - it is the caller's own inbox, and the
 * service scopes every query and every update to the authenticated user and
 * company. Authentication alone is the correct gate.
 */
router.get(
  '/',
  validateQuery(notificationListQuerySchema),
  asyncHandler(notificationController.list)
);

router.get('/unread-count', asyncHandler(notificationController.unreadCount));

router.patch('/read-all', asyncHandler(notificationController.markAllRead));

router.patch(
  '/:id/read',
  validateParams(idParamSchema),
  asyncHandler(notificationController.markRead)
);

export default router;
