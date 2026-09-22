import { AccountMappingType, Prisma } from '@prisma/client';
import { Database, prisma } from '../../database/prisma';
import { AuthContext } from '../../context/authContext';
import { conflict, notFound } from '../../utils/errors';
import {
  OPTIONAL_ACCOUNTING_ROLES,
  REQUIRED_ACCOUNTING_ROLES,
} from '../../constants/accounting';
import { COMPANY_SCOPE_KEY } from './chartOfAccounts.service';

export interface ResolvedAccount {
  ledgerId: string;
  ledgerCode: string;
  ledgerName: string;
  headCode: string;
  headName: string;
  natureCode: string;
  /** Where the answer came from: a branch override, or the company default. */
  resolvedFrom: 'BRANCH' | 'COMPANY';
  /** Whether the mapping named the ledger outright or went through its head. */
  via: 'LEDGER' | 'HEAD';
}

const ledgerInclude = {
  head: { include: { natureType: { include: { nature: true } } } },
} satisfies Prisma.LedgerInclude;

type LedgerWithHead = Prisma.LedgerGetPayload<{ include: typeof ledgerInclude }>;

function present(
  ledger: LedgerWithHead,
  resolvedFrom: ResolvedAccount['resolvedFrom'],
  via: ResolvedAccount['via']
): ResolvedAccount {
  return {
    ledgerId: ledger.id,
    ledgerCode: ledger.code,
    ledgerName: ledger.name,
    headCode: ledger.head.code,
    headName: ledger.head.name,
    natureCode: ledger.head.natureType.nature.code,
    resolvedFrom,
    via,
  };
}

/**
 * Turns a posting role into the account it should hit.
 *
 * This is the single reason no business service in the codebase names a ledger
 * code. `postSalesAccounting` asks for SALES; whether that is 4101, or an account
 * the company re-pointed it at, or a different account for one branch, is
 * configuration rather than code. Hard-coding 4101 in a controller would mean a
 * company that renumbered its chart could not be onboarded without a code change,
 * and a mis-typed constant would post revenue to an expense account silently.
 *
 * Resolution order is branch override, then company default. A branch row is how
 * one site settles into its own bank account without needing its own chart.
 *
 * A HEAD mapping is resolved to a postable ledger under that head: the head's
 * default when one is marked, or the only ledger under it. A head carrying
 * several ledgers and no default is refused rather than guessed - picking, say,
 * the lowest code would quietly redirect every payment the day a second bank
 * account is opened.
 */
export async function resolveAccountingAccount(
  companyId: string,
  branchId: string | null,
  mappingType: AccountMappingType,
  db: Database = prisma
): Promise<ResolvedAccount> {
  const scopeKeys = branchId ? [branchId, COMPANY_SCOPE_KEY] : [COMPANY_SCOPE_KEY];

  const mappings = await db.accountMapping.findMany({
    where: { companyId, mappingType, scopeKey: { in: scopeKeys } },
    include: {
      ledger: { include: ledgerInclude },
      head: true,
    },
  });
  if (mappings.length === 0) {
    throw conflict(
      'No accounting mapping is configured for ' +
        mappingType +
        '. Initialise the company chart of accounts before posting.'
    );
  }

  // Branch first; the company row is the fallback, not an alternative.
  const mapping =
    mappings.find((m) => branchId !== null && m.scopeKey === branchId) ??
    mappings.find((m) => m.scopeKey === COMPANY_SCOPE_KEY)!;
  const resolvedFrom: ResolvedAccount['resolvedFrom'] =
    mapping.scopeKey === COMPANY_SCOPE_KEY ? 'COMPANY' : 'BRANCH';

  if (mapping.target === 'LEDGER') {
    if (!mapping.ledger) {
      throw conflict('Accounting mapping ' + mappingType + ' names no ledger');
    }
    if (!mapping.ledger.isActive) {
      throw conflict(
        'Accounting mapping ' +
          mappingType +
          ' points at ledger ' +
          mapping.ledger.code +
          ', which is inactive'
      );
    }
    return present(mapping.ledger, resolvedFrom, 'LEDGER');
  }

  if (!mapping.headId) {
    throw conflict('Accounting mapping ' + mappingType + ' names no head');
  }

  const candidates = await db.ledger.findMany({
    where: { companyId, headId: mapping.headId, isActive: true },
    include: ledgerInclude,
    orderBy: { code: 'asc' },
  });
  if (candidates.length === 0) {
    throw conflict(
      'Accounting mapping ' +
        mappingType +
        ' points at head ' +
        (mapping.head?.code ?? mapping.headId) +
        ', which has no active ledger under it'
    );
  }

  const chosen = candidates.find((l) => l.isDefault);
  if (chosen) {
    return present(chosen, resolvedFrom, 'HEAD');
  }
  if (candidates.length === 1) {
    return present(candidates[0], resolvedFrom, 'HEAD');
  }

  throw conflict(
    'Accounting mapping ' +
      mappingType +
      ' points at head ' +
      (mapping.head?.code ?? mapping.headId) +
      ', which has ' +
      candidates.length +
      ' active ledgers (' +
      candidates.map((l) => l.code).join(', ') +
      ') and no default. Mark one as the default, or map the role to a ledger directly.'
  );
}

/**
 * Resolves several roles at once for a single posting.
 *
 * Every account a journal needs is resolved before any of it is written, so a
 * missing mapping fails the whole posting rather than leaving a half-built entry
 * for the transaction to roll back.
 */
export async function resolveAccounts<K extends string>(
  companyId: string,
  branchId: string | null,
  roles: Record<K, AccountMappingType>,
  db: Database = prisma
): Promise<Record<K, ResolvedAccount>> {
  const entries = Object.entries(roles) as [K, AccountMappingType][];
  const resolved = await Promise.all(
    entries.map(([, mappingType]) =>
      resolveAccountingAccount(companyId, branchId, mappingType, db)
    )
  );
  return Object.fromEntries(entries.map(([key], i) => [key, resolved[i]])) as Record<
    K,
    ResolvedAccount
  >;
}

/**
 * Resolves a tax role, falling back to the reporting format's own single TAX role.
 *
 * The shipped Ind AS format nets input and output tax into one liability head. A
 * deployment that splits them configures INPUT_TAX and OUTPUT_TAX; one that has
 * not is not broken, and still posts - to TAX, exactly as the format intends.
 *
 * The fallback is deliberately conditional on the role being *absent* rather than
 * on resolution failing. Catching every error here would mean a configured
 * INPUT_TAX pointing at a disabled or ambiguous account silently redirected input
 * tax into the output tax liability, which balances and is wrong - the sort of
 * error nobody finds until a return is filed.
 */
export async function resolveTaxAccount(
  companyId: string,
  branchId: string | null,
  preferred: AccountMappingType,
  db: Database = prisma
): Promise<ResolvedAccount> {
  const configured = await db.accountMapping.count({
    where: { companyId, mappingType: preferred },
  });
  if (configured === 0) {
    return resolveAccountingAccount(companyId, branchId, AccountMappingType.TAX, db);
  }
  // Configured: any failure from here is a real misconfiguration and is raised.
  return resolveAccountingAccount(companyId, branchId, preferred, db);
}

/* ------------------------------------------------------------------ reads ---- */

export async function listAccountMappings(auth: AuthContext) {
  const rows = await prisma.accountMapping.findMany({
    where: { companyId: auth.companyId },
    include: {
      head: { select: { code: true, name: true } },
      ledger: { select: { code: true, name: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ mappingType: 'asc' }, { scopeKey: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    mappingType: row.mappingType,
    target: row.target,
    scope: row.branch ? 'BRANCH' : 'COMPANY',
    branch: row.branch,
    head: row.head,
    ledger: row.ledger,
  }));
}

/**
 * Resolves every configured role and reports what each one lands on.
 *
 * Used by the reconciliation report and the verification script: a chart can look
 * complete and still have a role that cannot be posted to, and finding that out
 * during a month-end posting run is far too late.
 */
export async function describeResolvedMappings(companyId: string): Promise<
  {
    mappingType: AccountMappingType;
    resolved: ResolvedAccount | null;
    error: string | null;
  }[]
> {
  const configured = await prisma.accountMapping.findMany({
    where: { companyId },
    select: { mappingType: true },
    distinct: ['mappingType'],
    orderBy: { mappingType: 'asc' },
  });

  const results = [];
  for (const { mappingType } of configured) {
    try {
      results.push({
        mappingType,
        resolved: await resolveAccountingAccount(companyId, null, mappingType),
        error: null,
      });
    } catch (error) {
      results.push({
        mappingType,
        resolved: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/* ----------------------------------------------------------- mapping health ---- */

export type MappingHealthStatus = 'PASS' | 'NOT_CONFIGURED' | 'ERROR';

export interface MappingHealthRow {
  mappingType: AccountMappingType;
  required: boolean;
  status: MappingHealthStatus;
  resolved: ResolvedAccount | null;
  error: string | null;
}

export interface MappingHealth {
  initialized: boolean;
  templateKey: string | null;
  rows: MappingHealthRow[];
  /** Whether every required role resolves to a postable account. */
  postable: boolean;
  failing: number;
}

/**
 * Whether this company can actually post, role by role.
 *
 * `describeResolvedMappings` answers a narrower question: of the mappings that
 * exist, which resolve. That cannot see the failure that matters most, because a
 * role nobody configured has no row to report on - VENDOR simply would not appear
 * in the list, and a chart missing it would look healthy right up until the first
 * supplier invoice refused to book.
 *
 * So this walks the roles the posting paths need rather than the rows the table
 * happens to hold, and a required role with no mapping is reported as
 * NOT_CONFIGURED rather than omitted. That is the whole point of the screen: to
 * make missing accounting configuration something an administrator finds before
 * the workflow does.
 *
 * Roles are resolved at company scope. A branch override that is broken while the
 * company default is sound would not show here; it shows when that branch posts,
 * with the branch named in the error.
 */
export async function getMappingHealth(companyId: string): Promise<MappingHealth> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { accountingTemplateKey: true },
  });
  if (!company) {
    throw notFound('Company not found');
  }

  const roles: { mappingType: AccountMappingType; required: boolean }[] = [
    ...REQUIRED_ACCOUNTING_ROLES.map((r) => ({
      mappingType: r as AccountMappingType,
      required: true,
    })),
    ...OPTIONAL_ACCOUNTING_ROLES.map((r) => ({
      mappingType: r as AccountMappingType,
      required: false,
    })),
  ];

  const configured = new Set(
    (
      await prisma.accountMapping.findMany({
        where: { companyId },
        select: { mappingType: true },
        distinct: ['mappingType'],
      })
    ).map((m) => m.mappingType)
  );

  const rows: MappingHealthRow[] = [];
  for (const role of roles) {
    if (!configured.has(role.mappingType)) {
      rows.push({
        mappingType: role.mappingType,
        required: role.required,
        status: 'NOT_CONFIGURED',
        resolved: null,
        error: role.required
          ? 'No mapping is configured for ' +
            role.mappingType +
            '. Postings that need this role will be refused.'
          : null,
      });
      continue;
    }

    try {
      rows.push({
        mappingType: role.mappingType,
        required: role.required,
        status: 'PASS',
        resolved: await resolveAccountingAccount(companyId, null, role.mappingType),
        error: null,
      });
    } catch (error) {
      rows.push({
        mappingType: role.mappingType,
        required: role.required,
        status: 'ERROR',
        resolved: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failing = rows.filter((r) => r.required && r.status !== 'PASS').length;

  return {
    initialized: Boolean(company.accountingTemplateKey),
    templateKey: company.accountingTemplateKey,
    rows,
    postable: failing === 0,
    failing,
  };
}

export async function assertCompanyAccountingReady(
  companyId: string,
  db: Database = prisma
): Promise<void> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { accountingTemplateKey: true },
  });
  if (!company) {
    throw notFound('Company not found');
  }
  if (!company.accountingTemplateKey) {
    throw conflict(
      'Accounting has not been initialised for this company. ' +
        'Run the chart of accounts initialisation before posting.'
    );
  }
}
