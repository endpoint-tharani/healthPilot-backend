import { Router } from 'express';
import { creditNoteController } from '../controller/creditNote.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { documentListQuerySchema, idParamSchema } from '../schemas/common';
import { createCreditNoteSchema } from '../schemas/creditNote';

const router = Router();

router.post(
  '/',
  authorizePermission(Permission.CREDIT_NOTE_CREATE),
  validateBody(createCreditNoteSchema),
  asyncHandler(creditNoteController.create)
);

router.get(
  '/',
  authorizePermission(Permission.CREDIT_NOTE_VIEW),
  validateQuery(documentListQuerySchema),
  asyncHandler(creditNoteController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.CREDIT_NOTE_VIEW),
  validateParams(idParamSchema),
  asyncHandler(creditNoteController.getById)
);

export default router;
