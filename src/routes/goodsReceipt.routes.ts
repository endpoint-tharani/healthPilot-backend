import { Router } from 'express';
import { goodsReceiptController } from '../controller/goodsReceipt.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { documentListQuerySchema, idParamSchema, optionalReasonSchema } from '../schemas/common';
import { createGoodsReceiptSchema } from '../schemas/goodsReceipt';

const router = Router();

router.post(
  '/',
  authorizePermission(Permission.GOODS_RECEIPT_CREATE),
  validateBody(createGoodsReceiptSchema),
  asyncHandler(goodsReceiptController.create)
);

router.get(
  '/',
  authorizePermission(Permission.GOODS_RECEIPT_VIEW),
  validateQuery(documentListQuerySchema),
  asyncHandler(goodsReceiptController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.GOODS_RECEIPT_VIEW),
  validateParams(idParamSchema),
  asyncHandler(goodsReceiptController.getById)
);

router.post(
  '/:id/post',
  authorizePermission(Permission.GOODS_RECEIPT_POST),
  validateParams(idParamSchema),
  validateBody(optionalReasonSchema),
  asyncHandler(goodsReceiptController.post)
);

export default router;
