import { Prisma } from '@prisma/client';
import { AuthContext } from '../../context/authContext';
import { money, sum, ZERO } from '../../utils/decimal';
import { LedgerBalance, getLedgerBalances } from './generalLedger.service';

export interface ReportFilters {
  branchId?: string;
  fromDate?: Date;
  toDate?: Date;
}

interface ReportScope {
  branchId: string | null;
  fromDate: string | null;
  toDate: string | null;
}

function scopeOf(filters: ReportFilters): ReportScope {
  return {
    branchId: filters.branchId ?? null,
    fromDate: filters.fromDate ? filters.fromDate.toISOString() : null,
    toDate: filters.toDate ? filters.toDate.toISOString() : null,
  };
}

/* ------------------------------------------------------------ trial balance ---- */

export interface TrialBalanceRow {
  ledgerId: string;
  code: string;
  name: string;
  natureCode: string;
  natureName: string;
  headCode: string;
  headName: string;
  debit: string;
  credit: string;
}

/**
 * Every account's net movement in the period, debits in one column and credits in
 * the other.
 *
 * An account is shown on the side its balance actually falls, not on the side its
 * nature suggests: a bank account overdrawn in the period is a credit balance and
 * is reported as one. Showing the gross debit and credit turnover instead would
 * always balance regardless of whether the books do, which would make the report
 * incapable of detecting the very thing it exists to detect.
 *
 * Because every posted journal balances, the two columns must agree. If they do
 * not, something has written to the tables outside the journal service, and the
 * report says so rather than presenting a difference as a rounding note.
 */
export async function getTrialBalance(auth: AuthContext, filters: ReportFilters) {
  const balances = await getLedgerBalances(auth, filters);

  const rows: TrialBalanceRow[] = balances.map((row) => {
    const net = row.net;
    return {
      ledgerId: row.ledgerId,
      code: row.code,
      name: row.name,
      natureCode: row.natureCode,
      natureName: row.natureName,
      headCode: row.headCode,
      headName: row.headName,
      debit: net.greaterThan(0) ? net.toFixed(2) : '0.00',
      credit: net.lessThan(0) ? net.negated().toFixed(2) : '0.00',
    };
  });

  const totalDebit = money(sum(rows.map((r) => r.debit)));
  const totalCredit = money(sum(rows.map((r) => r.credit)));
  const difference = money(totalDebit.minus(totalCredit));
  const isBalanced = difference.isZero();

  return {
    scope: scopeOf(filters),
    rows,
    totals: {
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      difference: difference.toFixed(2),
    },
    isBalanced,
    integrityError: isBalanced
      ? null
      : 'Trial balance does not balance: debit ' +
        totalDebit.toFixed(2) +
        ' against credit ' +
        totalCredit.toFixed(2) +
        ' (difference ' +
        difference.toFixed(2) +
        '). Every posted journal balances by construction, so a difference here means rows ' +
        'were written to JournalLine outside the journal service.',
  };
}

/* --------------------------------------------------------------- P&L (P19) ---- */

export interface ReportSection {
  code: string;
  name: string;
  amount: string;
  heads: { code: string; name: string; amount: string; ledgers: ReportLedgerRow[] }[];
}

export interface ReportLedgerRow {
  ledgerId: string;
  code: string;
  name: string;
  amount: string;
}

/**
 * Rolls ledger balances up the reporting hierarchy into captions.
 *
 * `sign` flips the natural side: income and liabilities carry credit balances, and
 * a statement that printed them as negative numbers would be unreadable. Figures
 * are presented positive on their own side, which is how Schedule III reads.
 */
function rollUp(
  balances: LedgerBalance[],
  natureCodes: string[],
  sign: 1 | -1
): { sections: ReportSection[]; total: Prisma.Decimal } {
  const inScope = balances.filter((b) => natureCodes.includes(b.natureCode));

  const byNatureType = new Map<string, LedgerBalance[]>();
  for (const balance of inScope) {
    const list = byNatureType.get(balance.natureTypeCode) ?? [];
    list.push(balance);
    byNatureType.set(balance.natureTypeCode, list);
  }

  const sections: ReportSection[] = [];
  let total = ZERO;

  for (const [natureTypeCode, group] of byNatureType) {
    const byHead = new Map<string, LedgerBalance[]>();
    for (const balance of group) {
      const list = byHead.get(balance.headCode) ?? [];
      list.push(balance);
      byHead.set(balance.headCode, list);
    }

    const heads = [];
    let sectionTotal = ZERO;

    for (const [headCode, headLedgers] of byHead) {
      const ledgerRows: ReportLedgerRow[] = headLedgers.map((l) => ({
        ledgerId: l.ledgerId,
        code: l.code,
        name: l.name,
        amount: money(l.net.times(sign)).toFixed(2),
      }));
      const headTotal = money(sum(headLedgers.map((l) => l.net.times(sign))));
      sectionTotal = sectionTotal.plus(headTotal);
      heads.push({
        code: headCode,
        name: headLedgers[0].headName,
        amount: headTotal.toFixed(2),
        ledgers: ledgerRows.sort((a, b) => a.code.localeCompare(b.code)),
      });
    }

    total = total.plus(sectionTotal);
    sections.push({
      code: natureTypeCode,
      name: group[0].natureTypeName,
      amount: money(sectionTotal).toFixed(2),
      heads: heads.sort((a, b) => a.code.localeCompare(b.code)),
    });
  }

  return {
    sections: sections.sort((a, b) => a.code.localeCompare(b.code)),
    total: money(total),
  };
}

/**
 * Income less expenses for the period, on the Ind AS nature hierarchy.
 *
 * Every figure comes from posted journal lines. Nothing in this report is stored,
 * carried forward or hard-coded, so a mis-posting shows up as a wrong number here
 * rather than being papered over by a cached total.
 */
export async function getProfitAndLoss(auth: AuthContext, filters: ReportFilters) {
  const balances = await getLedgerBalances(auth, filters);

  // Income is credit-natured, so its net (debit - credit) is negative; flipping
  // the sign presents revenue as a positive figure.
  const income = rollUp(balances, ['IN'], -1);
  const expenses = rollUp(balances, ['EX'], 1);

  const netProfit = money(income.total.minus(expenses.total));

  return {
    scope: scopeOf(filters),
    income: {
      sections: income.sections,
      total: income.total.toFixed(2),
    },
    expenses: {
      sections: expenses.sections,
      total: expenses.total.toFixed(2),
    },
    totalIncome: income.total.toFixed(2),
    totalExpenses: expenses.total.toFixed(2),
    netProfit: netProfit.toFixed(2),
    isProfit: netProfit.greaterThanOrEqualTo(0),
  };
}

/* ------------------------------------------------------- balance sheet (P20) ---- */

/**
 * Assets against liabilities and equity, on the Ind AS hierarchy.
 *
 * The period's result is carried into equity explicitly rather than left out.
 * Income and expense accounts do not appear on a balance sheet, so a sheet built
 * from asset, liability and equity accounts alone is out by exactly the profit
 * for the period - it would report as unbalanced on a perfectly sound set of
 * books. Closing the result into retained earnings is what a year-end close does
 * in the ledger; presenting it here does the same thing for a report run
 * mid-period, without writing anything.
 *
 * The accounting equation is checked and any difference is reported as an
 * integrity error rather than hidden in a balancing figure.
 */
export async function getBalanceSheet(auth: AuthContext, filters: ReportFilters) {
  const balances = await getLedgerBalances(auth, filters);

  const assets = rollUp(balances, ['AS'], 1);
  const liabilities = rollUp(balances, ['LI'], -1);
  const equity = rollUp(balances, ['EQ'], -1);

  const income = money(sum(balances.filter((b) => b.natureCode === 'IN').map((b) => b.net.negated())));
  const expenses = money(sum(balances.filter((b) => b.natureCode === 'EX').map((b) => b.net)));
  const retainedResult = money(income.minus(expenses));

  const totalAssets = assets.total;
  const totalEquityWithResult = money(equity.total.plus(retainedResult));
  const totalLiabilitiesAndEquity = money(liabilities.total.plus(totalEquityWithResult));
  const difference = money(totalAssets.minus(totalLiabilitiesAndEquity));
  const isBalanced = difference.isZero();

  return {
    scope: scopeOf(filters),
    assets: { sections: assets.sections, total: totalAssets.toFixed(2) },
    liabilities: { sections: liabilities.sections, total: liabilities.total.toFixed(2) },
    equity: {
      sections: equity.sections,
      /** Equity as posted, before the period's own result is added. */
      postedTotal: equity.total.toFixed(2),
      /**
       * The period's income less expenses, shown as the retained result. Not a
       * posting - closing entries write this to retained earnings at year end.
       */
      retainedResultForPeriod: retainedResult.toFixed(2),
      total: totalEquityWithResult.toFixed(2),
    },
    totals: {
      totalAssets: totalAssets.toFixed(2),
      totalLiabilities: liabilities.total.toFixed(2),
      totalEquity: totalEquityWithResult.toFixed(2),
      totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toFixed(2),
      difference: difference.toFixed(2),
    },
    isBalanced,
    integrityError: isBalanced
      ? null
      : 'Assets of ' +
        totalAssets.toFixed(2) +
        ' do not equal liabilities and equity of ' +
        totalLiabilitiesAndEquity.toFixed(2) +
        ' (difference ' +
        difference.toFixed(2) +
        '). The period result of ' +
        retainedResult.toFixed(2) +
        ' is already included in equity, so a remaining difference means the ledger itself is unbalanced.',
  };
}
