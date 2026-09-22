import { AccountGroupType, AccountMappingTarget, AccountMappingType, BalanceType } from '@prisma/client';
import indAsTemplate from './accountingTemplates/indAsReporting.template.json';
import indAsOverlay from './accountingTemplates/indAsReporting.pharmacy.overlay.json';

/* ------------------------------------------------------- template shapes ---- */

export interface TemplateNature {
  code: string;
  name: string;
  ledgerCodeRange: [number, number];
}

export interface TemplateNatureType {
  code: string;
  name: string;
  natureCode: string;
}

export interface TemplateHead {
  code: string;
  name: string;
  natureTypeCode: string;
  isLocked?: boolean;
}

export interface TemplateGroup {
  code: string;
  name: string;
  headCode: string;
  groupType: string;
  isLocked?: boolean;
}

export interface TemplateSubGroup {
  code: string;
  name: string;
  groupCode: string;
  isLocked?: boolean;
}

export interface TemplateLedger {
  code: string;
  name: string;
  headCode: string;
  groupCode?: string;
  subGroupCode?: string;
  openingBalanceType: string;
  isLocked?: boolean;
  isDefault?: boolean;
  description?: string;
}

export interface TemplateMapping {
  type: string;
  target: string;
  code: string;
}

export interface AccountingTemplate {
  key: string;
  name: string;
  version: string;
  description: string;
  natures: TemplateNature[];
  natureTypes: TemplateNatureType[];
  heads: TemplateHead[];
  groups: TemplateGroup[];
  subGroups: TemplateSubGroup[];
  ledgers: TemplateLedger[];
  defaultMappings: TemplateMapping[];
}

interface TemplateOverlay {
  templateKey: string;
  appliesToVersion: string;
  ledgers: TemplateLedger[];
  defaultLedgers: { headCode: string; ledgerCode: string }[];
  additionalMappings: TemplateMapping[];
}

/* -------------------------------------------------------------- registry ---- */

export const IND_AS_TEMPLATE_KEY = 'IND_AS';

/** The reporting format a company is initialised from when none is recorded. */
export const DEFAULT_ACCOUNTING_TEMPLATE_KEY = IND_AS_TEMPLATE_KEY;

const OVERLAYS: Record<string, TemplateOverlay> = {
  [IND_AS_TEMPLATE_KEY]: indAsOverlay as unknown as TemplateOverlay,
};

const TEMPLATES: Record<string, AccountingTemplate> = {
  [IND_AS_TEMPLATE_KEY]: indAsTemplate as unknown as AccountingTemplate,
};

/**
 * The reporting format, with the deployment's own postable accounts folded in.
 *
 * The shipped Ind AS format is a presentation hierarchy: it names the captions a
 * Schedule III balance sheet has to show, and for six of the roles its own
 * defaultMappings point at - Trade Receivables, Trade payables, Cash, Bank, tax
 * and Inventories - it declares the caption but no account underneath it, so
 * nothing could actually be posted to them. Rather than edit a vendor file that
 * other systems read, the overlay adds those accounts under captions the format
 * already declares, and the merge is applied here so every caller sees one
 * template.
 */
export function resolveTemplate(key: string): AccountingTemplate {
  const base = TEMPLATES[key];
  if (!base) {
    throw new Error(
      'Unknown accounting template "' + key + '". Known templates: ' + Object.keys(TEMPLATES).join(', ')
    );
  }

  const overlay = OVERLAYS[key];
  if (!overlay) {
    return base;
  }
  if (overlay.appliesToVersion !== base.version) {
    throw new Error(
      'Accounting overlay for ' +
        key +
        ' targets template version ' +
        overlay.appliesToVersion +
        ' but the template is version ' +
        base.version +
        '. Re-check the overlay before initialising any company.'
    );
  }

  const defaultByHead = new Map(overlay.defaultLedgers.map((d) => [d.headCode, d.ledgerCode]));
  const ledgers: TemplateLedger[] = [
    ...base.ledgers.map((ledger) => ({
      ...ledger,
      isDefault: defaultByHead.get(ledger.headCode) === ledger.code ? true : ledger.isDefault,
    })),
    ...overlay.ledgers,
  ];

  return {
    ...base,
    ledgers,
    defaultMappings: [...base.defaultMappings, ...overlay.additionalMappings],
  };
}

export function listTemplateKeys(): string[] {
  return Object.keys(TEMPLATES);
}

/* ------------------------------------------------------------ enum guards ---- */

export function toBalanceType(value: string): BalanceType {
  if (value !== 'DR' && value !== 'CR') {
    throw new Error('Invalid opening balance type in template: ' + value);
  }
  return value as BalanceType;
}

export function toGroupType(value: string): AccountGroupType {
  if (value !== 'NORMAL' && value !== 'PRIMARY') {
    throw new Error('Invalid group type in template: ' + value);
  }
  return value as AccountGroupType;
}

export function toMappingType(value: string): AccountMappingType {
  if (!(value in AccountMappingType)) {
    throw new Error('Invalid mapping type in template: ' + value);
  }
  return value as AccountMappingType;
}

export function toMappingTarget(value: string): AccountMappingTarget {
  if (value !== 'HEAD' && value !== 'LEDGER') {
    throw new Error('Invalid mapping target in template: ' + value);
  }
  return value as AccountMappingTarget;
}
