import { Router } from 'express';
import { branchController } from '../controller/branch.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { idParamSchema } from '../schemas/common';
import { branchListQuerySchema, createBranchSchema, updateBranchSchema } from '../schemas/branch';

const router = Router();

router.get(
  '/',
  authorizePermission(Permission.BRANCH_VIEW),
  validateQuery(branchListQuerySchema),
  asyncHandler(branchController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.BRANCH_VIEW),
  validateParams(idParamSchema),
  asyncHandler(branchController.getById)
);

router.post(
  '/',
  authorizePermission(Permission.BRANCH_MANAGE),
  validateBody(createBranchSchema),
  asyncHandler(branchController.create)
);

router.put(
  '/:id',
  authorizePermission(Permission.BRANCH_MANAGE),
  validateParams(idParamSchema),
  validateBody(updateBranchSchema),
  asyncHandler(branchController.update)
);

export default router;
