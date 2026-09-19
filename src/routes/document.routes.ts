import { Router } from 'express';
import { documentController } from '../controller/document.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { idParamSchema } from '../schemas/common';
import { documentRegisterQuerySchema } from '../schemas/document';

const router = Router();

router.get(
  '/',
  authorizePermission(Permission.DOCUMENT_VIEW),
  validateQuery(documentRegisterQuerySchema),
  asyncHandler(documentController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.DOCUMENT_VIEW),
  validateParams(idParamSchema),
  asyncHandler(documentController.getById)
);

router.get(
  '/:id/history',
  authorizePermission(Permission.AUDIT_VIEW),
  validateParams(idParamSchema),
  asyncHandler(documentController.history)
);

export default router;
