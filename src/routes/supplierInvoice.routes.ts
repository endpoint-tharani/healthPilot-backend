import { Router } from 'express';
import { supplierInvoiceController } from '../controller/supplierInvoice.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { documentListQuerySchema, idParamSchema } from '../schemas/common';
import { createInvoiceSchema } from '../schemas/supplierInvoice';

const router = Router();

router.post(
  '/',
  authorizePermission(Permission.SUPPLIER_INVOICE_CREATE),
  validateBody(createInvoiceSchema),
  asyncHandler(supplierInvoiceController.create)
);

router.get(
  '/',
  authorizePermission(Permission.SUPPLIER_INVOICE_VIEW),
  validateQuery(documentListQuerySchema),
  asyncHandler(supplierInvoiceController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.SUPPLIER_INVOICE_VIEW),
  validateParams(idParamSchema),
  asyncHandler(supplierInvoiceController.getById)
);

export default router;
