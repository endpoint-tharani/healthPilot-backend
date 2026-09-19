import { Router } from 'express';
import { productController } from '../controller/product.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { idParamSchema } from '../schemas/common';
import {
  createProductSchema,
  productListQuerySchema,
  updateProductSchema,
} from '../schemas/product';

const router = Router();

router.get(
  '/',
  authorizePermission(Permission.PRODUCT_VIEW),
  validateQuery(productListQuerySchema),
  asyncHandler(productController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.PRODUCT_VIEW),
  validateParams(idParamSchema),
  asyncHandler(productController.getById)
);

router.post(
  '/',
  authorizePermission(Permission.PRODUCT_MANAGE),
  validateBody(createProductSchema),
  asyncHandler(productController.create)
);

router.put(
  '/:id',
  authorizePermission(Permission.PRODUCT_MANAGE),
  validateParams(idParamSchema),
  validateBody(updateProductSchema),
  asyncHandler(productController.update)
);

export default router;
