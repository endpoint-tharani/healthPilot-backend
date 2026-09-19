import { Router } from 'express';
import { userController } from '../controller/user.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { idParamSchema } from '../schemas/common';
import { createUserSchema, updateUserSchema, userListQuerySchema } from '../schemas/user';

const router = Router();

router.get(
  '/',
  authorizePermission(Permission.USER_VIEW),
  validateQuery(userListQuerySchema),
  asyncHandler(userController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.USER_VIEW),
  validateParams(idParamSchema),
  asyncHandler(userController.getById)
);

router.post(
  '/',
  authorizePermission(Permission.USER_MANAGE),
  validateBody(createUserSchema),
  asyncHandler(userController.create)
);

router.put(
  '/:id',
  authorizePermission(Permission.USER_MANAGE),
  validateParams(idParamSchema),
  validateBody(updateUserSchema),
  asyncHandler(userController.update)
);

export default router;
