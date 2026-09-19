import { Router } from 'express';
import { receiptCorrectionController } from '../controller/receiptCorrection.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { documentListQuerySchema, idParamSchema } from '../schemas/common';
import { createCorrectionSchema } from '../schemas/receiptCorrection';

const router = Router();

router.post(
  '/',
  authorizePermission(Permission.RECEIPT_CORRECTION_CREATE),
  validateBody(createCorrectionSchema),
  asyncHandler(receiptCorrectionController.create)
);

router.get(
  '/',
  authorizePermission(Permission.RECEIPT_CORRECTION_VIEW),
  validateQuery(documentListQuerySchema),
  asyncHandler(receiptCorrectionController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.RECEIPT_CORRECTION_VIEW),
  validateParams(idParamSchema),
  asyncHandler(receiptCorrectionController.getById)
);

export default router;
