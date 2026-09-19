import { Router } from 'express';
import { supplierController } from '../controller/supplier.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { idParamSchema } from '../schemas/common';
import {
  createSupplierSchema,
  supplierListQuerySchema,
  updateSupplierSchema,
} from '../schemas/supplier';

const router = Router();

router.get(
  '/',
  authorizePermission(Permission.SUPPLIER_VIEW),
  validateQuery(supplierListQuerySchema),
  asyncHandler(supplierController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.SUPPLIER_VIEW),
  validateParams(idParamSchema),
  asyncHandler(supplierController.getById)
);

router.post(
  '/',
  authorizePermission(Permission.SUPPLIER_MANAGE),
  validateBody(createSupplierSchema),
  asyncHandler(supplierController.create)
);

router.put(
  '/:id',
  authorizePermission(Permission.SUPPLIER_MANAGE),
  validateParams(idParamSchema),
  validateBody(updateSupplierSchema),
  asyncHandler(supplierController.update)
);

export default router;
