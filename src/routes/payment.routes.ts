import { Router } from 'express';
import { paymentController } from '../controller/payment.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { idParamSchema } from '../schemas/common';
import {
  allocatePaymentSchema,
  createPaymentSchema,
  paymentListQuerySchema,
} from '../schemas/payment';

const router = Router();

router.post(
  '/',
  authorizePermission(Permission.PAYMENT_CREATE),
  validateBody(createPaymentSchema),
  asyncHandler(paymentController.create)
);

router.get(
  '/',
  authorizePermission(Permission.PAYMENT_VIEW),
  validateQuery(paymentListQuerySchema),
  asyncHandler(paymentController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.PAYMENT_VIEW),
  validateParams(idParamSchema),
  asyncHandler(paymentController.getById)
);

router.post(
  '/:id/allocate',
  authorizePermission(Permission.PAYMENT_ALLOCATE),
  validateParams(idParamSchema),
  validateBody(allocatePaymentSchema),
  asyncHandler(paymentController.allocate)
);

export default router;
