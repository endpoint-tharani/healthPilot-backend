import { Router } from 'express';
import { accountingController } from '../controller/accounting.controller';
import { asyncHandler } from '../handlers/asyncHandler';
import { authorizePermission } from '../middleware/authorizePermission';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import { Permission } from '../constants/permissions';
import { idParamSchema } from '../schemas/common';
import {
  generalLedgerQuerySchema,
  initializeAccountingSchema,
  journalListQuerySchema,
  ledgerQuerySchema,
  mappingTypeParamSchema,
  paymentIdParamSchema,
  reportQuerySchema,
  resolveMappingQuerySchema,
  reverseJournalSchema,
  supplierLedgerQuerySchema,
  supplierOutstandingQuerySchema,
} from '../schemas/accounting';

const router = Router();

/* ---------------------------------------------------------- chart of accounts ---- */

router.post(
  '/initialize',
  authorizePermission(Permission.ACCOUNTING_MANAGE),
  validateBody(initializeAccountingSchema),
  asyncHandler(accountingController.initialize)
);

router.get(
  '/chart-of-accounts',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  asyncHandler(accountingController.chartOfAccounts)
);

router.get(
  '/ledgers',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateQuery(ledgerQuerySchema),
  asyncHandler(accountingController.ledgers)
);

/* ------------------------------------------------------------------ mappings ---- */

router.get(
  '/mappings',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  asyncHandler(accountingController.mappings)
);

router.get(
  '/mappings/resolved',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  asyncHandler(accountingController.resolvedMappings)
);

// Whether this company can post at all, role by role. Deliberately reachable
// before anything is raised: missing accounting configuration should be found
// here, not by an invoice that refuses to book.
router.get(
  '/mappings/health',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  asyncHandler(accountingController.mappingHealth)
);

router.get(
  '/mappings/:mappingType/resolve',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateParams(mappingTypeParamSchema),
  validateQuery(resolveMappingQuerySchema),
  asyncHandler(accountingController.resolveMapping)
);

/* ------------------------------------------------------------------ journals ---- */

router.get(
  '/journals',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateQuery(journalListQuerySchema),
  asyncHandler(accountingController.journals)
);

router.get(
  '/journals/:id',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateParams(idParamSchema),
  asyncHandler(accountingController.journal)
);

// A posted journal is never edited or deleted. Correcting one raises its mirror
// image, which is why the only write here is a reversal.
router.post(
  '/journals/:id/reverse',
  authorizePermission(Permission.ACCOUNTING_POST),
  validateParams(idParamSchema),
  validateBody(reverseJournalSchema),
  asyncHandler(accountingController.reverseJournal)
);

/* ------------------------------------------------------------- posting events ---- */

// Raising accounting is an explicit, idempotent event against a source document:
// calling it twice returns the journal raised the first time.
router.post(
  '/documents/:id/post',
  authorizePermission(Permission.ACCOUNTING_POST),
  validateParams(idParamSchema),
  asyncHandler(accountingController.postDocument)
);

router.get(
  '/documents/:id/journals',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateParams(idParamSchema),
  asyncHandler(accountingController.journalsForDocument)
);

// A payment is not a Document, so it needs its own posting route rather than
// being reachable only through the invoices it happens to settle. Same guarantee:
// posting twice returns the entry the first call raised.
router.post(
  '/payments/:paymentId/post',
  authorizePermission(Permission.ACCOUNTING_POST),
  validateParams(paymentIdParamSchema),
  asyncHandler(accountingController.postPayment)
);

router.get(
  '/payments/:paymentId/journals',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateParams(paymentIdParamSchema),
  asyncHandler(accountingController.journalsForPayment)
);

/* --------------------------------------------------------- supplier ledger ---- */

// The accounts payable subledger: the payables control account read per supplier.
router.get(
  '/supplier-ledger',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateQuery(supplierLedgerQuerySchema),
  asyncHandler(accountingController.supplierLedger)
);

router.get(
  '/supplier-outstanding',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateQuery(supplierOutstandingQuerySchema),
  asyncHandler(accountingController.supplierOutstanding)
);

/* ------------------------------------------------------------- general ledger ---- */

router.get(
  '/general-ledger',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateQuery(generalLedgerQuerySchema),
  asyncHandler(accountingController.generalLedger)
);

/* ------------------------------------------------------------------- reports ---- */

router.get(
  '/reports/trial-balance',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateQuery(reportQuerySchema),
  asyncHandler(accountingController.trialBalance)
);

router.get(
  '/reports/profit-loss',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateQuery(reportQuerySchema),
  asyncHandler(accountingController.profitLoss)
);

router.get(
  '/reports/balance-sheet',
  authorizePermission(Permission.ACCOUNTING_VIEW),
  validateQuery(reportQuerySchema),
  asyncHandler(accountingController.balanceSheet)
);

export default router;
