import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Database, prisma, transaction } from '../../database/prisma';
import { AuthContext } from '../../context/authContext';
import { badRequest, notFound } from '../../utils/errors';
import { logger } from '../../loggers';
import {
  AccountingTemplate,
  DEFAULT_ACCOUNTING_TEMPLATE_KEY,
  resolveTemplate,
  toBalanceType,
  toGroupType,
  toMappingTarget,
  toMappingType,
} from '../../constants/accounts';

export interface InitializeCounts {
  natures: number;
  natureTypes: number;
  heads: number;
  groups: number;
  subGroups: number;
  ledgers: number;
  mappings: number;
}

export interface InitializeResult {
  companyId: string;
  templateKey: string;
  templateVersion: string;
  /** True when the chart was already complete and nothing new had to be written. */
  alreadyInitialized: boolean;
  created: InitializeCounts;
  total: InitializeCounts;
}

/* ----------------------------------------------------- template validation ---- */

/**
 * Checks the reporting format hangs together before a single row is written.
 *
 * Initialisation runs in one transaction, so a template naming a head that does
 * not exist would fail part way through and roll back anyway - but it would fail
 * with a foreign-key violation quoting a uuid, which tells nobody which line of
 * the template is wrong. Validating up front turns that into a message naming the
 * offending code.
 */
export function validateTemplate(template: AccountingTemplate): void {
  const problems: string[] = [];

  const natureByCode = new Map(template.natures.map((n) => [n.code, n]));
  const natureTypeByCode = new Map(template.natureTypes.map((t) => [t.code, t]));
  const headByCode = new Map(template.heads.map((h) => [h.code, h]));
  const groupByCode = new Map(template.groups.map((g) => [g.code, g]));
  const subGroupByCode = new Map(template.subGroups.map((s) => [s.code, s]));
  const ledgerByCode = new Map(template.ledgers.map((l) => [l.code, l]));

  const assertUnique = (label: string, codes: string[]) => {
    const seen = new Set<string>();
    for (const code of codes) {
      if (seen.has(code)) {
        problems.push(label + ' code "' + code + '" is declared more than once');
      }
      seen.add(code);
    }
  };
  assertUnique('Nature', template.natures.map((n) => n.code));
  assertUnique('Nature type', template.natureTypes.map((t) => t.code));
  assertUnique('Head', template.heads.map((h) => h.code));
  assertUnique('Group', template.groups.map((g) => g.code));
  assertUnique('Sub-group', template.subGroups.map((s) => s.code));
  assertUnique('Ledger', template.ledgers.map((l) => l.code));

  for (const natureType of template.natureTypes) {
    if (!natureByCode.has(natureType.natureCode)) {
      problems.push(
        'Nature type ' + natureType.code + ' refers to unknown nature ' + natureType.natureCode
      );
    }
  }
  for (const head of template.heads) {
    if (!natureTypeByCode.has(head.natureTypeCode)) {
      problems.push('Head ' + head.code + ' refers to unknown nature type ' + head.natureTypeCode);
    }
  }
  for (const group of template.groups) {
    if (!headByCode.has(group.headCode)) {
      problems.push('Group ' + group.code + ' refers to unknown head ' + group.headCode);
    }
  }
  for (const subGroup of template.subGroups) {
    if (!groupByCode.has(subGroup.groupCode)) {
      problems.push('Sub-group ' + subGroup.code + ' refers to unknown group ' + subGroup.groupCode);
    }
  }

  const natureCodeForHead = (headCode: string): string | undefined => {
    const head = headByCode.get(headCode);
    return head ? natureTypeByCode.get(head.natureTypeCode)?.natureCode : undefined;
  };

  for (const ledger of template.ledgers) {
    if (!headByCode.has(ledger.headCode)) {
      problems.push('Ledger ' + ledger.code + ' refers to unknown head ' + ledger.headCode);
      continue;
    }

    // A ledger whose group belongs to a different head would be reported under two
    // captions at once, so the parentage has to agree all the way up.
    if (ledger.groupCode) {
      const group = groupByCode.get(ledger.groupCode);
      if (!group) {
        problems.push('Ledger ' + ledger.code + ' refers to unknown group ' + ledger.groupCode);
      } else if (group.headCode !== ledger.headCode) {
        problems.push(
          'Ledger ' +
            ledger.code +
            ' sits under head ' +
            ledger.headCode +
            ' but its group ' +
            ledger.groupCode +
            ' belongs to head ' +
            group.headCode
        );
      }
    }
    if (ledger.subGroupCode) {
      const subGroup = subGroupByCode.get(ledger.subGroupCode);
      if (!subGroup) {
        problems.push(
          'Ledger ' + ledger.code + ' refers to unknown sub-group ' + ledger.subGroupCode
        );
      } else if (ledger.groupCode && subGroup.groupCode !== ledger.groupCode) {
        problems.push(
          'Ledger ' +
            ledger.code +
            ' names sub-group ' +
            ledger.subGroupCode +
            ', which belongs to group ' +
            subGroup.groupCode +
            ' rather than ' +
            ledger.groupCode
        );
      }
    }

    // The nature code range is what keeps 4101 an income account and 5101 an
    // expense one in every company initialised from this format.
    const natureCode = natureCodeForHead(ledger.headCode);
    const nature = natureCode ? natureByCode.get(natureCode) : undefined;
    const numeric = Number(ledger.code);
    if (nature && Number.isInteger(numeric)) {
      const [from, to] = nature.ledgerCodeRange;
      if (numeric < from || numeric > to) {
        problems.push(
          'Ledger ' + ledger.code + ' falls outside the ' + nature.code + ' range ' + from + '-' + to
        );
      }
    }
  }

  // At most one default ledger per head. The default is what a head-target
  // mapping resolves to, so two of them would make "post this to BANK" ambiguous.
  const defaultsByHead = new Map<string, string[]>();
  for (const ledger of template.ledgers.filter((l) => l.isDefault)) {
    const codes = defaultsByHead.get(ledger.headCode) ?? [];
    codes.push(ledger.code);
    defaultsByHead.set(ledger.headCode, codes);
  }
  for (const [headCode, codes] of defaultsByHead) {
    if (codes.length > 1) {
      problems.push(
        'Head ' + headCode + ' declares more than one default ledger (' + codes.join(', ') + ')'
      );
    }
  }

  // Every mapping has to resolve to something postable. Catching it here is the
  // difference between a clear error at initialisation and a failed posting
  // halfway through a dispensing transaction months later.
  for (const mapping of template.defaultMappings) {
    if (mapping.target === 'LEDGER') {
      if (!ledgerByCode.has(mapping.code)) {
        problems.push('Mapping ' + mapping.type + ' refers to unknown ledger ' + mapping.code);
      }
      continue;
    }
    if (!headByCode.has(mapping.code)) {
      problems.push('Mapping ' + mapping.type + ' refers to unknown head ' + mapping.code);
      continue;
    }
    const under = template.ledgers.filter((l) => l.headCode === mapping.code);
    if (under.length === 0) {
      problems.push(
        'Mapping ' +
          mapping.type +
          ' points at head ' +
          mapping.code +
          ', which has no ledger under it, so nothing could ever be posted to it'
      );
    } else if (under.length > 1 && !under.some((l) => l.isDefault)) {
      problems.push(
        'Mapping ' +
          mapping.type +
          ' points at head ' +
          mapping.code +
          ', which carries ' +
          under.length +
          ' ledgers and names no default, so it is ambiguous'
      );
    }
  }

  if (problems.length > 0) {
    throw badRequest(
      'Accounting template ' +
        template.key +
        ' is not usable: ' +
        problems.length +
        ' problem(s) found',
      problems
    );
  }
}

/* --------------------------------------------------------- initialisation ---- */

/* --------------------------------------------------------- initialisation ---- */

interface LevelPlan<TRow, TCreate> {
  existing: Map<string, TRow>;
  creates: TCreate[];
  idByCode: Map<string, string>;
}

/**
 * Works out, for one level of the chart, which rows already exist and which have
 * to be written - reading the level in one query and assigning ids to the new
 * rows up front, so they can be inserted with a single createMany and still be
 * referenced by the level below without being read back.
 */
function planLevel<
  TItem extends { code: string },
  TRow extends { id: string; code: string },
  TCreate,
>(
  items: TItem[],
  existingRows: TRow[],
  toCreate: (item: TItem, id: string, index: number) => TCreate
): LevelPlan<TRow, TCreate> {
  const existing = new Map(existingRows.map((row) => [row.code, row]));
  const idByCode = new Map<string, string>();
  const creates: TCreate[] = [];

  for (const [index, item] of items.entries()) {
    const found = existing.get(item.code);
    if (found) {
      idByCode.set(item.code, found.id);
      continue;
    }
    const id = randomUUID();
    idByCode.set(item.code, id);
    creates.push(toCreate(item, id, index));
  }

  return { existing, creates, idByCode };
}

/**
 * Creates one company's chart of accounts from a reporting format, and is safe to
 * run again as many times as anyone likes.
 *
 * Idempotency is structural rather than a guard at the top: every master is keyed
 * on (companyId, code), which is a real unique index, so a second run finds the
 * same rows and writes nothing new. That matters more than it sounds - the seed
 * runs this on every pass, and a chart that grew a second Sales account each time
 * would put half the revenue in one and half in the other, both reporting under
 * the same caption, with a Trial Balance that still balanced.
 *
 * Each of the seven levels costs one read and at most one write. The obvious
 * shape - upsert each master in turn - is two round trips per row, and at a
 * hundred-odd masters over a network database that alone exceeded the sixty
 * second transaction budget before a single ledger had been written. Ids for new
 * rows are generated here rather than by the database, which is what lets one
 * level be inserted in a single statement and still be referenced by the level
 * beneath it.
 *
 * What a re-run deliberately does NOT do is rename anything. Writing the
 * template's name back over every row would undo a company's own renaming of an
 * unlocked account on each seed. Names are refreshed only for locked masters,
 * which the reporting format owns and the company was never able to edit.
 */
export async function initializeCompanyAccounting(
  companyId: string,
  templateKey: string = DEFAULT_ACCOUNTING_TEMPLATE_KEY
): Promise<InitializeResult> {
  const template = resolveTemplate(templateKey);
  validateTemplate(template);

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, accountingTemplateKey: true },
  });
  if (!company) {
    throw notFound('Company not found');
  }
  if (company.accountingTemplateKey && company.accountingTemplateKey !== template.key) {
    // Re-basing a live chart onto a different format would silently re-point every
    // posted journal at a caption that may now mean something else.
    throw badRequest(
      'Company is already initialised from accounting template ' +
        company.accountingTemplateKey +
        ' and cannot be re-initialised from ' +
        template.key
    );
  }

  const created: InitializeCounts = {
    natures: 0,
    natureTypes: 0,
    heads: 0,
    groups: 0,
    subGroups: 0,
    ledgers: 0,
    mappings: 0,
  };

  await transaction(async (tx) => {
    /* -- natures ----------------------------------------------------------- */
    const natures = planLevel(
      template.natures,
      await tx.accountNature.findMany({
        where: { companyId },
        select: { id: true, code: true, ledgerCodeFrom: true, ledgerCodeTo: true, sortOrder: true },
      }),
      (nature, id, index) => ({
        id,
        companyId,
        code: nature.code,
        name: nature.name,
        ledgerCodeFrom: nature.ledgerCodeRange[0],
        ledgerCodeTo: nature.ledgerCodeRange[1],
        sortOrder: index,
      })
    );
    if (natures.creates.length > 0) {
      await tx.accountNature.createMany({ data: natures.creates });
      created.natures = natures.creates.length;
    }
    // Code ranges are owned by the reporting format, so a change to them is
    // carried over. Nothing else about an existing nature is touched.
    for (const [index, nature] of template.natures.entries()) {
      const row = natures.existing.get(nature.code);
      if (
        row &&
        (row.ledgerCodeFrom !== nature.ledgerCodeRange[0] ||
          row.ledgerCodeTo !== nature.ledgerCodeRange[1] ||
          row.sortOrder !== index)
      ) {
        await tx.accountNature.update({
          where: { id: row.id },
          data: {
            ledgerCodeFrom: nature.ledgerCodeRange[0],
            ledgerCodeTo: nature.ledgerCodeRange[1],
            sortOrder: index,
          },
        });
      }
    }

    /* -- nature types ------------------------------------------------------ */
    const natureTypes = planLevel(
      template.natureTypes,
      await tx.accountNatureType.findMany({
        where: { companyId },
        select: { id: true, code: true, sortOrder: true },
      }),
      (natureType, id, index) => ({
        id,
        companyId,
        code: natureType.code,
        name: natureType.name,
        natureId: natures.idByCode.get(natureType.natureCode)!,
        sortOrder: index,
      })
    );
    if (natureTypes.creates.length > 0) {
      await tx.accountNatureType.createMany({ data: natureTypes.creates });
      created.natureTypes = natureTypes.creates.length;
    }

    /* -- heads ------------------------------------------------------------- */
    const heads = planLevel(
      template.heads,
      await tx.accountHead.findMany({
        where: { companyId },
        select: { id: true, code: true, name: true, isLocked: true, sortOrder: true },
      }),
      (head, id, index) => ({
        id,
        companyId,
        code: head.code,
        name: head.name,
        natureTypeId: natureTypes.idByCode.get(head.natureTypeCode)!,
        isLocked: head.isLocked ?? false,
        sortOrder: index,
      })
    );
    if (heads.creates.length > 0) {
      await tx.accountHead.createMany({ data: heads.creates });
      created.heads = heads.creates.length;
    }
    for (const head of template.heads.filter((h) => h.isLocked)) {
      const row = heads.existing.get(head.code);
      if (row && (row.name !== head.name || !row.isLocked)) {
        await tx.accountHead.update({
          where: { id: row.id },
          data: { name: head.name, isLocked: true },
        });
      }
    }

    /* -- groups ------------------------------------------------------------ */
    const groups = planLevel(
      template.groups,
      await tx.accountGroup.findMany({
        where: { companyId },
        select: { id: true, code: true, name: true, isLocked: true },
      }),
      (group, id, index) => ({
        id,
        companyId,
        code: group.code,
        name: group.name,
        headId: heads.idByCode.get(group.headCode)!,
        groupType: toGroupType(group.groupType),
        isLocked: group.isLocked ?? false,
        sortOrder: index,
      })
    );
    if (groups.creates.length > 0) {
      await tx.accountGroup.createMany({ data: groups.creates });
      created.groups = groups.creates.length;
    }
    for (const group of template.groups.filter((g) => g.isLocked)) {
      const row = groups.existing.get(group.code);
      if (row && (row.name !== group.name || !row.isLocked)) {
        await tx.accountGroup.update({
          where: { id: row.id },
          data: { name: group.name, isLocked: true },
        });
      }
    }

    /* -- sub-groups -------------------------------------------------------- */
    const subGroups = planLevel(
      template.subGroups,
      await tx.accountSubGroup.findMany({
        where: { companyId },
        select: { id: true, code: true, name: true, isLocked: true },
      }),
      (subGroup, id, index) => ({
        id,
        companyId,
        code: subGroup.code,
        name: subGroup.name,
        groupId: groups.idByCode.get(subGroup.groupCode)!,
        isLocked: subGroup.isLocked ?? false,
        sortOrder: index,
      })
    );
    if (subGroups.creates.length > 0) {
      await tx.accountSubGroup.createMany({ data: subGroups.creates });
      created.subGroups = subGroups.creates.length;
    }

    /* -- ledgers ----------------------------------------------------------- */
    const ledgers = planLevel(
      template.ledgers,
      await tx.ledger.findMany({
        where: { companyId },
        select: { id: true, code: true, name: true, isLocked: true, isDefault: true },
      }),
      (ledger, id, index) => ({
        id,
        companyId,
        code: ledger.code,
        name: ledger.name,
        headId: heads.idByCode.get(ledger.headCode)!,
        groupId: ledger.groupCode ? groups.idByCode.get(ledger.groupCode)! : null,
        subGroupId: ledger.subGroupCode ? subGroups.idByCode.get(ledger.subGroupCode)! : null,
        openingBalanceType: toBalanceType(ledger.openingBalanceType),
        isDefault: ledger.isDefault ?? false,
        isLocked: ledger.isLocked ?? false,
        description: ledger.description ?? null,
        sortOrder: index,
      })
    );
    if (ledgers.creates.length > 0) {
      await tx.ledger.createMany({ data: ledgers.creates });
      created.ledgers = ledgers.creates.length;
    }
    // isDefault is refreshed even on unlocked ledgers: it is routing rather than a
    // label, and a stale default silently sends postings to the wrong account.
    for (const ledger of template.ledgers) {
      const row = ledgers.existing.get(ledger.code);
      if (!row) {
        continue;
      }
      const wantDefault = ledger.isDefault ?? false;
      const renameLocked = Boolean(ledger.isLocked) && (row.name !== ledger.name || !row.isLocked);
      if (row.isDefault !== wantDefault || renameLocked) {
        await tx.ledger.update({
          where: { id: row.id },
          data: {
            isDefault: wantDefault,
            ...(ledger.isLocked ? { name: ledger.name, isLocked: true } : {}),
          },
        });
      }
    }

    /* -- mappings ---------------------------------------------------------- */
    const existingMappings = await tx.accountMapping.findMany({
      where: { companyId, scopeKey: COMPANY_SCOPE_KEY },
      select: { mappingType: true },
    });
    const configured = new Set(existingMappings.map((m) => m.mappingType));

    const newMappings = template.defaultMappings
      .map((mapping) => ({ mapping, mappingType: toMappingType(mapping.type) }))
      // An existing mapping is left exactly as found. A company that re-pointed
      // SALES at its own account would otherwise have that undone by every seed.
      .filter(({ mappingType }) => !configured.has(mappingType))
      .map(({ mapping, mappingType }) => {
        const target = toMappingTarget(mapping.target);
        return {
          companyId,
          branchId: null,
          scopeKey: COMPANY_SCOPE_KEY,
          mappingType,
          target,
          headId: target === 'HEAD' ? heads.idByCode.get(mapping.code)! : null,
          ledgerId: target === 'LEDGER' ? ledgers.idByCode.get(mapping.code)! : null,
        };
      });

    if (newMappings.length > 0) {
      await tx.accountMapping.createMany({ data: newMappings });
      created.mappings = newMappings.length;
    }

    await tx.company.update({
      where: { id: companyId },
      data: {
        accountingTemplateKey: template.key,
        accountingTemplateVersion: template.version,
        accountingInitializedAt: new Date(),
      },
    });
  });

  const total = await countChart(companyId);
  const alreadyInitialized = Object.values(created).every((n) => n === 0);

  logger.info('Company accounting initialised', {
    companyId,
    template: template.key + '@' + template.version,
    created,
    alreadyInitialized,
  });

  return {
    companyId,
    templateKey: template.key,
    templateVersion: template.version,
    alreadyInitialized,
    created,
    total,
  };
}

/** The company-wide mapping scope. Branch overrides carry the branch id instead. */
export const COMPANY_SCOPE_KEY = '*';

export async function countChart(
  companyId: string,
  db: Database = prisma
): Promise<InitializeCounts> {
  const [natures, natureTypes, heads, groups, subGroups, ledgers, mappings] = await Promise.all([
    db.accountNature.count({ where: { companyId } }),
    db.accountNatureType.count({ where: { companyId } }),
    db.accountHead.count({ where: { companyId } }),
    db.accountGroup.count({ where: { companyId } }),
    db.accountSubGroup.count({ where: { companyId } }),
    db.ledger.count({ where: { companyId } }),
    db.accountMapping.count({ where: { companyId } }),
  ]);
  return { natures, natureTypes, heads, groups, subGroups, ledgers, mappings };
}

/* ------------------------------------------------------------- chart reads ---- */

export interface ChartNode {
  id: string;
  code: string;
  name: string;
  level: 'NATURE' | 'NATURE_TYPE' | 'HEAD' | 'GROUP' | 'SUB_GROUP' | 'LEDGER';
  parentCode: string | null;
  isLocked: boolean;
  isActive: boolean;
  children: ChartNode[];
  /** Ledger-only presentation detail. */
  openingBalanceType?: string;
  isDefault?: boolean;
}

/**
 * The whole chart for one company as a tree, in the reporting format's own order.
 *
 * Read in six queries rather than through nested includes: the chart is a few
 * hundred rows, and assembling it in memory keeps the shape of the tree in one
 * readable place instead of spread across a deeply nested Prisma include.
 */
export async function getChartOfAccounts(auth: AuthContext): Promise<{
  templateKey: string | null;
  templateVersion: string | null;
  initializedAt: Date | null;
  counts: InitializeCounts;
  tree: ChartNode[];
}> {
  const companyId = auth.companyId;

  const [company, natures, natureTypes, heads, groups, subGroups, ledgers] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: {
        accountingTemplateKey: true,
        accountingTemplateVersion: true,
        accountingInitializedAt: true,
      },
    }),
    prisma.accountNature.findMany({ where: { companyId }, orderBy: { sortOrder: 'asc' } }),
    prisma.accountNatureType.findMany({ where: { companyId }, orderBy: { sortOrder: 'asc' } }),
    prisma.accountHead.findMany({ where: { companyId }, orderBy: { sortOrder: 'asc' } }),
    prisma.accountGroup.findMany({ where: { companyId }, orderBy: { sortOrder: 'asc' } }),
    prisma.accountSubGroup.findMany({ where: { companyId }, orderBy: { sortOrder: 'asc' } }),
    prisma.ledger.findMany({ where: { companyId }, orderBy: { sortOrder: 'asc' } }),
  ]);

  const node = (
    row: { id: string; code: string; name: string },
    level: ChartNode['level'],
    parentCode: string | null,
    extra: Partial<ChartNode> = {}
  ): ChartNode => ({
    id: row.id,
    code: row.code,
    name: row.name,
    level,
    parentCode,
    isLocked: false,
    isActive: true,
    children: [],
    ...extra,
  });

  const ledgerNodes = ledgers.map((l) =>
    node(l, 'LEDGER', l.subGroupId ?? l.groupId ?? l.headId, {
      isLocked: l.isLocked,
      isActive: l.isActive,
      openingBalanceType: l.openingBalanceType,
      isDefault: l.isDefault,
    })
  );
  const ledgersByParent = new Map<string, ChartNode[]>();
  for (const [index, ledger] of ledgers.entries()) {
    const parentId = ledger.subGroupId ?? ledger.groupId ?? ledger.headId;
    const list = ledgersByParent.get(parentId) ?? [];
    list.push(ledgerNodes[index]);
    ledgersByParent.set(parentId, list);
  }

  const subGroupNodes = subGroups.map((s) => {
    const built = node(s, 'SUB_GROUP', s.groupId, { isLocked: s.isLocked, isActive: s.isActive });
    built.children = ledgersByParent.get(s.id) ?? [];
    return { row: s, built };
  });

  const groupNodes = groups.map((g) => {
    const built = node(g, 'GROUP', g.headId, { isLocked: g.isLocked, isActive: g.isActive });
    built.children = [
      ...subGroupNodes.filter((s) => s.row.groupId === g.id).map((s) => s.built),
      ...(ledgersByParent.get(g.id) ?? []),
    ];
    return { row: g, built };
  });

  const headNodes = heads.map((h) => {
    const built = node(h, 'HEAD', h.natureTypeId, { isLocked: h.isLocked, isActive: h.isActive });
    built.children = [
      ...groupNodes.filter((g) => g.row.headId === h.id).map((g) => g.built),
      ...(ledgersByParent.get(h.id) ?? []),
    ];
    return { row: h, built };
  });

  const natureTypeNodes = natureTypes.map((t) => {
    const built = node(t, 'NATURE_TYPE', t.natureId);
    built.children = headNodes.filter((h) => h.row.natureTypeId === t.id).map((h) => h.built);
    return { row: t, built };
  });

  const tree = natures.map((n) => {
    const built = node(n, 'NATURE', null);
    built.children = natureTypeNodes.filter((t) => t.row.natureId === n.id).map((t) => t.built);
    return built;
  });

  // Parent ids are internal; the client navigates by code.
  const codeById = new Map<string, string>();
  for (const row of [...natures, ...natureTypes, ...heads, ...groups, ...subGroups, ...ledgers]) {
    codeById.set(row.id, row.code);
  }
  const relabel = (nodes: ChartNode[]) => {
    for (const child of nodes) {
      child.parentCode = child.parentCode ? (codeById.get(child.parentCode) ?? null) : null;
      relabel(child.children);
    }
  };
  relabel(tree);

  return {
    templateKey: company.accountingTemplateKey,
    templateVersion: company.accountingTemplateVersion,
    initializedAt: company.accountingInitializedAt,
    counts: await countChart(companyId),
    tree,
  };
}

export interface LedgerListFilters {
  headCode?: string;
  natureCode?: string;
  search?: string;
  isActive?: boolean;
}

/** Flat ledger list, for pickers and the Ledger Accounts page. */
export async function listLedgers(auth: AuthContext, filters: LedgerListFilters = {}) {
  const where: Prisma.LedgerWhereInput = { companyId: auth.companyId };
  if (filters.isActive !== undefined) {
    where.isActive = filters.isActive;
  }
  // Both head filters live on the same relation, so the conditions are collected
  // and applied once - assigning twice would drop the first.
  if (filters.headCode || filters.natureCode) {
    where.head = {
      ...(filters.headCode ? { code: filters.headCode } : {}),
      ...(filters.natureCode
        ? { natureType: { nature: { code: filters.natureCode } } }
        : {}),
    };
  }
  if (filters.search) {
    where.OR = [
      { code: { contains: filters.search, mode: 'insensitive' } },
      { name: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.ledger.findMany({
    where,
    orderBy: { code: 'asc' },
    include: {
      head: { include: { natureType: { include: { nature: true } } } },
      group: { select: { code: true, name: true } },
      subGroup: { select: { code: true, name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    openingBalanceType: row.openingBalanceType,
    isDefault: row.isDefault,
    isLocked: row.isLocked,
    isActive: row.isActive,
    head: { code: row.head.code, name: row.head.name },
    natureType: { code: row.head.natureType.code, name: row.head.natureType.name },
    nature: { code: row.head.natureType.nature.code, name: row.head.natureType.nature.name },
    group: row.group ? { code: row.group.code, name: row.group.name } : null,
    subGroup: row.subGroup ? { code: row.subGroup.code, name: row.subGroup.name } : null,
  }));
}
