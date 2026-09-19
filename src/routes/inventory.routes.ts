import { Router } from 'express';
import { inventoryController } from '../controller/inventory.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { batchIdParamSchema, branchIdParamSchema, productIdParamSchema } from '../schemas/common';
import { ledgerQuerySchema, stockQuerySchema } from '../schemas/inventory';

const router = Router();

router.get(
  '/',
  authorizePermission(Permission.INVENTORY_VIEW),
  validateQuery(stockQuerySchema),
  asyncHandler(inventoryController.stock)
);

router.get(
  '/ledger',
  authorizePermission(Permission.INVENTORY_VIEW),
  validateQuery(ledgerQuerySchema),
  asyncHandler(inventoryController.ledger)
);

router.get(
  '/product/:productId',
  authorizePermission(Permission.INVENTORY_VIEW),
  validateParams(productIdParamSchema),
  validateQuery(stockQuerySchema),
  asyncHandler(inventoryController.byProduct)
);

router.get(
  '/batch/:batchId',
  authorizePermission(Permission.INVENTORY_VIEW),
  validateParams(batchIdParamSchema),
  validateQuery(stockQuerySchema),
  asyncHandler(inventoryController.byBatch)
);

router.get(
  '/branch/:branchId',
  authorizePermission(Permission.INVENTORY_VIEW),
  validateParams(branchIdParamSchema),
  validateQuery(stockQuerySchema),
  asyncHandler(inventoryController.byBranch)
);

export default router;
