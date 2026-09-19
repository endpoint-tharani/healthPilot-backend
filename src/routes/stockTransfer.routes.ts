import { Router } from 'express';
import { stockTransferController } from '../controller/stockTransfer.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { documentListQuerySchema, idParamSchema, optionalReasonSchema } from '../schemas/common';
import { createTransferSchema } from '../schemas/stockTransfer';

const router = Router();

router.post(
  '/',
  authorizePermission(Permission.STOCK_TRANSFER_CREATE),
  validateBody(createTransferSchema),
  asyncHandler(stockTransferController.create)
);

router.get(
  '/',
  authorizePermission(Permission.STOCK_TRANSFER_VIEW),
  validateQuery(documentListQuerySchema),
  asyncHandler(stockTransferController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.STOCK_TRANSFER_VIEW),
  validateParams(idParamSchema),
  asyncHandler(stockTransferController.getById)
);

router.post(
  '/:id/dispatch',
  authorizePermission(Permission.STOCK_TRANSFER_DISPATCH),
  validateParams(idParamSchema),
  validateBody(optionalReasonSchema),
  asyncHandler(stockTransferController.dispatch)
);

router.post(
  '/:id/receive',
  authorizePermission(Permission.STOCK_TRANSFER_RECEIVE),
  validateParams(idParamSchema),
  validateBody(optionalReasonSchema),
  asyncHandler(stockTransferController.receive)
);

export default router;
