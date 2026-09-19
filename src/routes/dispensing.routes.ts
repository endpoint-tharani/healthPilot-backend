import { Router } from 'express';
import { dispensingController } from '../controller/dispensing.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { documentListQuerySchema, idParamSchema } from '../schemas/common';
import { createDispensingSchema } from '../schemas/dispensing';

const router = Router();

router.post(
  '/',
  authorizePermission(Permission.DISPENSING_CREATE),
  validateBody(createDispensingSchema),
  asyncHandler(dispensingController.create)
);

router.get(
  '/',
  authorizePermission(Permission.DISPENSING_VIEW),
  validateQuery(documentListQuerySchema),
  asyncHandler(dispensingController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.DISPENSING_VIEW),
  validateParams(idParamSchema),
  asyncHandler(dispensingController.getById)
);

export default router;
