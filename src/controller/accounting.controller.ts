import { Request, Response } from 'express';
import { requireAuth } from '../context/authContext';
import { ok, okList } from '../handlers/response';
import { params, query } from '../middleware/validate';
import { IdParam } from '../schemas/common';
import {
  GeneralLedgerQuery,
  InitializeAccountingInput,
  JournalListQuery,
  LedgerQuery,
  MappingTypeParam,
  PaymentIdParam,
  ReportQuery,
  ResolveMappingQuery,
  ReverseJournalInput,
  SupplierLedgerQuery,
  SupplierOutstandingQuery,
} from '../schemas/accounting';
import {
  getChartOfAccounts,
  initializeCompanyAccounting,
  listLedgers,
} from '../services/accounting/chartOfAccounts.service';
import {
  describeResolvedMappings,
  getMappingHealth,
  listAccountMappings,
  resolveAccountingAccount,
} from '../services/accounting/accountMapping.service';
import {
  getJournalEntry,
  getJournalsForDocument,
  getJournalsForPayment,
  listJournalEntries,
  reverseJournalEntry,
} from '../services/accounting/journal.service';
import {
  retryDocumentAccounting,
  retryPaymentAccounting,
} from '../services/accounting/autoPost.service';
import {
  getSupplierLedger,
  getSupplierOutstanding,
} from '../services/accounting/supplierLedger.service';
import { getGeneralLedger } from '../services/accounting/generalLedger.service';
import {
  getBalanceSheet,
  getProfitAndLoss,
  getTrialBalance,
} from '../services/accounting/reports.service';

export const accountingController = {
  /* ------------------------------------------------------ chart of accounts ---- */

  async initialize(req: Request, res: Response) {
    const auth = requireAuth(req);
    const body = req.body as InitializeAccountingInput;
    return ok(res, await initializeCompanyAccounting(auth.companyId, body.templateKey));
  },

  async chartOfAccounts(req: Request, res: Response) {
    return ok(res, await getChartOfAccounts(requireAuth(req)));
  },

  async ledgers(req: Request, res: Response) {
    return ok(res, await listLedgers(requireAuth(req), query<LedgerQuery>(req)));
  },

  /* -------------------------------------------------------------- mappings ---- */

  async mappings(req: Request, res: Response) {
    return ok(res, await listAccountMappings(requireAuth(req)));
  },

  async resolvedMappings(req: Request, res: Response) {
    return ok(res, await describeResolvedMappings(requireAuth(req).companyId));
  },

  /** Every role a posting needs, and whether it currently resolves. */
  async mappingHealth(req: Request, res: Response) {
    return ok(res, await getMappingHealth(requireAuth(req).companyId));
  },

  async resolveMapping(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { mappingType } = params<MappingTypeParam>(req);
    const { branchId } = query<ResolveMappingQuery>(req);
    return ok(
      res,
      await resolveAccountingAccount(auth.companyId, branchId ?? null, mappingType)
    );
  },

  /* -------------------------------------------------------------- journals ---- */

  async journals(req: Request, res: Response) {
    const result = await listJournalEntries(requireAuth(req), query<JournalListQuery>(req));
    return okList(res, result.data, result.meta);
  },

  async journal(req: Request, res: Response) {
    return ok(res, await getJournalEntry(requireAuth(req), params<IdParam>(req).id));
  },

  async journalsForDocument(req: Request, res: Response) {
    return ok(res, await getJournalsForDocument(requireAuth(req), params<IdParam>(req).id));
  },

  async reverseJournal(req: Request, res: Response) {
    const auth = requireAuth(req);
    const { reason } = req.body as ReverseJournalInput;
    return ok(res, await reverseJournalEntry(auth, params<IdParam>(req).id, reason));
  },

  /**
   * Re-raises the accounting for one business document.
   *
   * Documents now post their own accounting when they are finalised, so this is
   * the recovery path rather than the normal one: a tenant onboarded onto
   * accounting after the fact, or a posting that failed and was fixed. It stays
   * idempotent, so repeated clicks return the journal the first one raised
   * instead of booking the liability again.
   */
  async postDocument(req: Request, res: Response) {
    return ok(res, await retryDocumentAccounting(requireAuth(req), params<IdParam>(req).id));
  },

  /** The same recovery path for a supplier payment, which is not a Document. */
  async postPayment(req: Request, res: Response) {
    const { paymentId } = params<PaymentIdParam>(req);
    return ok(res, await retryPaymentAccounting(requireAuth(req), paymentId));
  },

  async journalsForPayment(req: Request, res: Response) {
    const { paymentId } = params<PaymentIdParam>(req);
    return ok(res, await getJournalsForPayment(requireAuth(req), paymentId));
  },

  /* ------------------------------------------------------ supplier ledger ---- */

  async supplierLedger(req: Request, res: Response) {
    return ok(res, await getSupplierLedger(requireAuth(req), query<SupplierLedgerQuery>(req)));
  },

  async supplierOutstanding(req: Request, res: Response) {
    return ok(
      res,
      await getSupplierOutstanding(requireAuth(req), query<SupplierOutstandingQuery>(req))
    );
  },

  /* ------------------------------------------------------------- gl/reports ---- */

  async generalLedger(req: Request, res: Response) {
    const result = await getGeneralLedger(requireAuth(req), query<GeneralLedgerQuery>(req));
    const { data, meta, ...summary } = result;
    return okList(res, data, { ...meta, ...summary });
  },

  async trialBalance(req: Request, res: Response) {
    return ok(res, await getTrialBalance(requireAuth(req), query<ReportQuery>(req)));
  },

  async profitLoss(req: Request, res: Response) {
    return ok(res, await getProfitAndLoss(requireAuth(req), query<ReportQuery>(req)));
  },

  async balanceSheet(req: Request, res: Response) {
    return ok(res, await getBalanceSheet(requireAuth(req), query<ReportQuery>(req)));
  },
};
