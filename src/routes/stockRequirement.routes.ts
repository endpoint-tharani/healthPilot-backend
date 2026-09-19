import { Router } from 'express';
import { stockRequirementController } from '../controller/stockRequirement.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import {
  documentListQuerySchema,
  idParamSchema,
  optionalReasonSchema,
  requiredReasonSchema,
} from '../schemas/common';
import { createRequirementSchema } from '../schemas/stockRequirement';

const router = Router();

router.post(
  '/',
  authorizePermission(Permission.STOCK_REQUIREMENT_CREATE),
  validateBody(createRequirementSchema),
  asyncHandler(stockRequirementController.create)
);

router.get(
  '/',
  authorizePermission(Permission.STOCK_REQUIREMENT_VIEW),
  validateQuery(documentListQuerySchema),
  asyncHandler(stockRequirementController.list)
);

router.get(
  '/:id',
  authorizePermission(Permission.STOCK_REQUIREMENT_VIEW),
  validateParams(idParamSchema),
  asyncHandler(stockRequirementController.getById)
);

/**
 * Read-only sourcing view. STOCK_REQUIREMENT_VIEW is the right gate: anyone who
 * may read the requirement may be told whether it can be met internally. WHICH
 * branches hold the stock is a second decision, taken inside the service.
 */
router.get(
  '/:id/internal-availability',
  authorizePermission(Permission.STOCK_REQUIREMENT_VIEW),
  validateParams(idParamSchema),
  asyncHandler(stockRequirementController.internalAvailability)
);

/**
 * The sourcing view the UI actually works from. It is a superset of
 * internal-availability - same engine, regrouped by branch, with the supplier
 * side beside it - and stays separate because availability is on the hot path
 * for every requirement page, while the supplier history behind this one is not
 * worth paying for on a read that only wants the fulfilment figure.
 */
router.get(
  '/:id/sourcing-analysis',
  authorizePermission(Permission.STOCK_REQUIREMENT_VIEW),
  validateParams(idParamSchema),
  asyncHandler(stockRequirementController.sourcingAnalysis)
);

router.post(
  '/:id/submit',
  authorizePermission(Permission.STOCK_REQUIREMENT_CREATE),
  validateParams(idParamSchema),
  validateBody(optionalReasonSchema),
  asyncHandler(stockRequirementController.submit)
);

router.post(
  '/:id/approve',
  authorizePermission(Permission.STOCK_REQUIREMENT_APPROVE),
  validateParams(idParamSchema),
  validateBody(optionalReasonSchema),
  asyncHandler(stockRequirementController.approve)
);

router.post(
  '/:id/reject',
  authorizePermission(Permission.STOCK_REQUIREMENT_APPROVE),
  validateParams(idParamSchema),
  validateBody(requiredReasonSchema),
  asyncHandler(stockRequirementController.reject)
);

export default router;
