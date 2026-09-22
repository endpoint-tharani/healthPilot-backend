import { AccountingEvent } from '@prisma/client';
import { AuditAction } from './audit';

export const JOURNAL_NUMBER_PREFIX = 'JV';
export const JOURNAL_SEQUENCE_WIDTH = 4;

/**
 * The per-company identity of one accounting event.
 *
 * This is the whole of the duplicate-posting defence: it is stored on the journal
 * entry and carries a unique index with the company id, so posting the same event
 * twice is refused by Postgres rather than by application logic that two
 * concurrent requests could both pass.
 *
 * Keys are built from the source row's id rather than its number, because a
 * document number is only unique per company and per type, while the id is
 * absolute - and because a key that embedded a number would break if numbering
 * were ever re-based.
 */
export function accountingEventKey(event: AccountingEvent, sourceId: string): string {
  return event + ':' + sourceId;
}

/**
 * Audit actions this module appends to a source document's history. Re-exported
 * from the project's single AuditAction registry rather than redeclared, so a
 * reader looking for every action a document can carry finds them all in one file.
 */
export const AccountingAuditAction = {
  ACCOUNTING_POSTED: AuditAction.ACCOUNTING_POSTED,
  ACCOUNTING_REVERSED: AuditAction.ACCOUNTING_REVERSED,
} as const;

/**
 * Document types that never produce a journal of their own.
 *
 * A stock transfer moves inventory between two branches of the same company. The
 * company owns the same stock, at the same cost, before and after, so there is no
 * revenue, no expense and no change in any balance sheet total - only the branch
 * the value sits at. Recognising a sale on it would let a company book profit by
 * moving boxes between its own shelves, and would double-count against the real
 * sale when the stock is eventually dispensed.
 *
 * Branch-level inventory reporting is served by the stock ledger, which already
 * records the movement per branch at cost.
 */
export const NON_ACCOUNTING_DOCUMENT_TYPES = [
  'STOCK_TRANSFER',
  'STOCK_REQUIREMENT',
  'PURCHASE_ORDER',
  // A goods receipt moves stock, but the payable is recognised at supplier
  // invoice stage under this deployment's policy, and the invoice journal already
  // debits inventory. Booking the receipt as well would double the asset.
  'GOODS_RECEIPT',
  'RECEIPT_CORRECTION',
] as const;

/**
 * The account roles a HealthPilot deployment cannot post without.
 *
 * The chart of accounts can look complete and still be unpostable: a role nobody
 * configured, a mapping pointing at a head with two ledgers and no default, a
 * ledger somebody deactivated. None of that shows up until an invoice is raised
 * and refuses to book, which is the worst possible moment to find out.
 *
 * This is the list the mapping health screen and the verification script check,
 * and it is exactly the set the four posting paths resolve: the supplier invoice
 * (VENDOR, INVENTORY, tax), the payment (VENDOR, BANK or CASH), the sale
 * (CUSTOMER or BANK or CASH, SALES, tax) and cost of sales (DIRECT_COST,
 * INVENTORY).
 */
export const REQUIRED_ACCOUNTING_ROLES = [
  'VENDOR',
  'CUSTOMER',
  'INVENTORY',
  'BANK',
  'CASH',
  'SALES',
  'DIRECT_COST',
  'TAX',
] as const;

/**
 * Roles that improve the books when configured and are not required.
 *
 * The shipped Ind AS format nets recoverable input tax against output tax in one
 * liability head, which balances and is what the format intends. A deployment
 * that wants them apart configures these two; one that has not is not broken, and
 * the health screen says so rather than reporting an error.
 */
export const OPTIONAL_ACCOUNTING_ROLES = ['INPUT_TAX', 'OUTPUT_TAX'] as const;

/**
 * The event key of a top-up posting for a supplier payment.
 *
 * A payment is normally booked once, for everything it settles. It can also be
 * allocated to a further invoice after that posting exists, and the first
 * journal cannot be edited to cover it - posted accounting is history. So the
 * increment is booked as its own entry, keyed on the allocation that caused it,
 * which keeps every event deterministic and idempotent: replaying the allocation
 * returns the entry it already raised rather than booking the money twice.
 */
export function paymentAllocationEventKey(paymentId: string, allocationId: string): string {
  return 'SUPPLIER_PAYMENT:' + paymentId + ':ALLOCATION:' + allocationId;
}
