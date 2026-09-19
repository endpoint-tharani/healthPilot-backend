import { Router } from 'express';
import { purchaseOrderController } from '../controller/purchaseOrder.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import {
  documentListQuerySchema,
  idParamSchema,
  optionalReasonSchema,
  requiredReasonSchema,
} from '../schemas/common';
import { createPurchaseOrderSchema } from '../schemas/purchaseOrder';

const router = Router();

router.post(
  '/',
  authorizePermission(Permission.PURCHASE_ORDER_CREATE),
  validateBody(createPurchaseOrderSchema),
  asyncHandler(purchaseOrderController.create)
);

router.get(
  '/',
  authorizePermission(Permission.PURCHASE_ORDER_VIEW),
  validateQuery(documentListQuerySchema),
  asyncHandler(purchaseOrderController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.PURCHASE_ORDER_VIEW),
  validateParams(idParamSchema),
  asyncHandler(purchaseOrderController.getById)
);

router.post(
  '/:id/approve',
  authorizePermission(Permission.PURCHASE_ORDER_APPROVE),
  validateParams(idParamSchema),
  validateBody(optionalReasonSchema),
  asyncHandler(purchaseOrderController.approve)
);

router.post(
  '/:id/cancel',
  authorizePermission(Permission.PURCHASE_ORDER_APPROVE),
  validateParams(idParamSchema),
  validateBody(requiredReasonSchema),
  asyncHandler(purchaseOrderController.cancel)
);

export default router;
