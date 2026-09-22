import { describe, expect, it } from 'vitest';
import {
  AccountingTemplate,
  IND_AS_TEMPLATE_KEY,
  listTemplateKeys,
  resolveTemplate,
} from '../../constants/accounts';
import { validateTemplate } from '../../services/accounting/chartOfAccounts.service';

/**
 * The reporting format and the deployment's overlay, checked without a database.
 *
 * A broken template is the one failure that would corrupt every company
 * initialised after it, so it is worth catching in a test that runs in
 * milliseconds rather than in a seed that runs against a live database.
 */

const template = resolveTemplate(IND_AS_TEMPLATE_KEY);

/** A deep copy, so a test that breaks the template cannot affect another. */
function mutable(): AccountingTemplate {
  return JSON.parse(JSON.stringify(template)) as AccountingTemplate;
}

/**
 * The problem list a rejected template carries.
 *
 * `validateTemplate` throws one summary message and puts every individual fault
 * in `details`, so that an operator sees "6 problems" once rather than fixing
 * them one failed run at a time. The tests therefore assert on the details rather
 * than on the message.
 */
function problemsFrom(template: AccountingTemplate): string[] {
  try {
    validateTemplate(template);
  } catch (error) {
    return ((error as { details?: string[] }).details ?? []).map(String);
  }
  throw new Error('expected the template to be rejected, but it validated');
}

describe('the shipped Ind AS reporting format', () => {
  it('is registered and resolvable', () => {
    expect(listTemplateKeys()).toContain(IND_AS_TEMPLATE_KEY);
    expect(template.key).toBe('IND_AS');
    expect(template.version).toBe('2.0.0');
  });

  it('passes its own validation', () => {
    expect(() => validateTemplate(template)).not.toThrow();
  });

  it('declares the five Ind AS natures with their code ranges', () => {
    const byCode = new Map(template.natures.map((n) => [n.code, n]));
    expect([...byCode.keys()].sort()).toEqual(['AS', 'EQ', 'EX', 'IN', 'LI']);
    // One nature per leading digit, so a code says which nature it belongs to.
    expect(byCode.get('AS')!.ledgerCodeRange).toEqual([100000000, 199999999]);
    expect(byCode.get('LI')!.ledgerCodeRange).toEqual([200000000, 299999999]);
    expect(byCode.get('EQ')!.ledgerCodeRange).toEqual([300000000, 399999999]);
    expect(byCode.get('IN')!.ledgerCodeRange).toEqual([400000000, 499999999]);
    expect(byCode.get('EX')!.ledgerCodeRange).toEqual([500000000, 599999999]);
  });

  it('keeps the heads the pharmacy workflow posts to, under their own codes', () => {
    const byCode = new Map(template.heads.map((h) => [h.code, h.name]));
    expect(byCode.get('10800')).toBe('Inventories');
    expect(byCode.get('11000')).toBe('Trade Receivables');
    expect(byCode.get('11100')).toBe('Cash & Cash Equivalents');
    expect(byCode.get('11200')).toBe('Bank Balances');
    expect(byCode.get('20900')).toBe('Trade Payables');
    expect(byCode.get('40100')).toBe('Revenue from Operations');
    expect(byCode.get('50100')).toBe('Cost of Materials Consumed');
  });

  it('keeps the three ledgers the assignment names, locked', () => {
    const byCode = new Map(template.ledgers.map((l) => [l.code, l]));
    expect(byCode.get('401010001')?.name).toBe('Sales');
    expect(byCode.get('501000001')?.name).toBe('COGS');
    expect(byCode.get('502010001')?.name).toBe('Purchases');
    expect(byCode.get('401010001')?.isLocked).toBe(true);
    expect(byCode.get('501000001')?.isLocked).toBe(true);
    expect(byCode.get('502010001')?.isLocked).toBe(true);
  });

  /**
   * The codes are positional, so this is not cosmetic: a ledger that is not a
   * digit-for-digit extension of its parents would report under one caption and
   * sort under another.
   */
  it('gives every master a code that spells out where it sits', () => {
    const headByCode = new Map(template.heads.map((h) => [h.code, h]));
    const groupByCode = new Map(template.groups.map((g) => [g.code, g]));

    for (const group of template.groups) {
      // A head is NHH00 and a group under it is NHHGG, so they share five digits
      // less the trailing 00.
      expect(group.code.slice(0, 3)).toBe(group.headCode.slice(0, 3));
      expect(group.code).toHaveLength(5);
      expect(group.headCode.endsWith('00')).toBe(true);
      expect(group.code.endsWith('00')).toBe(false);
    }

    for (const sub of template.subGroups) {
      expect(sub.code).toHaveLength(7);
      expect(sub.code.startsWith(sub.groupCode)).toBe(true);
    }

    for (const ledger of template.ledgers) {
      expect(ledger.code).toHaveLength(9);
      expect(headByCode.has(ledger.headCode)).toBe(true);
      expect(ledger.code.slice(0, 3)).toBe(ledger.headCode.slice(0, 3));
      if (ledger.subGroupCode) {
        expect(ledger.code.startsWith(ledger.subGroupCode)).toBe(true);
      } else if (ledger.groupCode) {
        expect(ledger.code.startsWith(groupByCode.get(ledger.groupCode)!.code)).toBe(true);
      }
    }
  });

  it('reproduces the Fixed Asset branch exactly as specified', () => {
    const ledgerByCode = new Map(template.ledgers.map((l) => [l.code, l.name]));
    expect(template.heads.find((h) => h.code === '10100')?.name).toBe('Fixed Asset');
    expect(template.groups.find((g) => g.code === '10101')?.name).toBe('Tangible Assets');
    expect(template.subGroups.find((s) => s.code === '1010101')?.name).toBe('Land');
    expect(template.subGroups.find((s) => s.code === '1010102')?.name).toBe('Buildings');

    expect(ledgerByCode.get('101010101')).toBe('Freehold Land');
    expect(ledgerByCode.get('101010102')).toBe('Leasehold Land');
    expect(ledgerByCode.get('101010103')).toBe('Land - Assets under Lease');
    expect(ledgerByCode.get('101010104')).toBe('Land Development Cost');
    expect(ledgerByCode.get('101010201')).toBe('Factory Buildings');
    expect(ledgerByCode.get('101010202')).toBe('Office Buildings');
    expect(ledgerByCode.get('101010203')).toBe('Residential Buildings / Staff Quarters');
    expect(ledgerByCode.get('101010204')).toBe('Leasehold Improvements');
    expect(ledgerByCode.get('101010205')).toBe('Buildings - Assets under Lease');
  });

  it('preserves the group and sub-group hierarchy rather than flattening it', () => {
    expect(template.groups.length).toBeGreaterThan(0);
    expect(template.subGroups.length).toBeGreaterThan(0);

    // Tangible Assets is the deepest branch: head -> group -> sub-group -> ledger.
    expect(template.subGroups.some((s) => s.groupCode === '10101')).toBe(true);

    // The non-MSME dues group stays the principal sub-classification under Trade
    // Payables, as the 1.x format had it.
    const primary = template.groups.find((g) => g.code === '20902');
    expect(primary?.groupType).toBe('PRIMARY');
    expect(primary?.headCode).toBe('20900');
  });

  it('keeps every posting role pointed at an account that exists', () => {
    const byType = new Map(template.defaultMappings.map((m) => [m.type, m]));
    expect(byType.get('CUSTOMER')).toMatchObject({ target: 'HEAD', code: '11000' });
    expect(byType.get('VENDOR')).toMatchObject({ target: 'HEAD', code: '20900' });
    expect(byType.get('SALES')).toMatchObject({ target: 'LEDGER', code: '401010001' });
    expect(byType.get('PURCHASE')).toMatchObject({ target: 'LEDGER', code: '502010001' });
    expect(byType.get('CASH')).toMatchObject({ target: 'HEAD', code: '11100' });
    expect(byType.get('BANK')).toMatchObject({ target: 'HEAD', code: '11200' });
    expect(byType.get('TAX')).toMatchObject({ target: 'HEAD', code: '21300' });
    expect(byType.get('ROUNDING')).toMatchObject({ target: 'LEDGER', code: '402000005' });
    expect(byType.get('DISCOUNT')).toMatchObject({ target: 'HEAD', code: '50700' });
    expect(byType.get('DIRECT_COST')).toMatchObject({ target: 'LEDGER', code: '501000001' });
    expect(byType.get('INDIRECT_COST')).toMatchObject({ target: 'HEAD', code: '50700' });
    expect(byType.get('INVENTORY')).toMatchObject({ target: 'HEAD', code: '10800' });
    expect(byType.get('OTHER')).toMatchObject({ target: 'LEDGER', code: '507020001' });
    expect(byType.get('INPUT_TAX')).toMatchObject({ target: 'LEDGER', code: '115010001' });
    expect(byType.get('OUTPUT_TAX')).toMatchObject({ target: 'LEDGER', code: '213010001' });
  });

  it('every ledger code sits inside its nature range', () => {
    const natureTypeByCode = new Map(template.natureTypes.map((t) => [t.code, t]));
    const headByCode = new Map(template.heads.map((h) => [h.code, h]));
    const natureByCode = new Map(template.natures.map((n) => [n.code, n]));

    for (const ledger of template.ledgers) {
      const head = headByCode.get(ledger.headCode)!;
      const nature = natureByCode.get(natureTypeByCode.get(head.natureTypeCode)!.natureCode)!;
      const code = Number(ledger.code);
      expect(code).toBeGreaterThanOrEqual(nature.ledgerCodeRange[0]);
      expect(code).toBeLessThanOrEqual(nature.ledgerCodeRange[1]);
    }
  });
});

describe('the postable accounts the pharmacy workflow needs', () => {
  /**
   * These lived in an overlay while the format was a vendor file that only
   * declared captions. The 2.0.0 chart is authored for this deployment, so they
   * are in the base template and the overlay is empty.
   */
  it('declares a default account under every caption the workflow posts to', () => {
    const defaultFor = (headCode: string) =>
      template.ledgers.find((l) => l.headCode === headCode && l.isDefault);

    expect(defaultFor('10800')?.name).toBe('Inventory - Pharmacy Stock');
    expect(defaultFor('11000')?.name).toBe('Trade Receivables - Patients');
    expect(defaultFor('11100')?.name).toBe('Cash in Hand');
    expect(defaultFor('11200')?.name).toBe('Bank Account');
    expect(defaultFor('20900')?.name).toBe('Trade Payables - Suppliers');
    expect(defaultFor('21300')?.name).toBe('Output GST Payable');
  });

  it('splits input tax out of the liability head so it presents as an asset', () => {
    const byType = new Map(template.defaultMappings.map((m) => [m.type, m]));
    const byCode = new Map(template.ledgers.map((l) => [l.code, l]));

    // Input tax is recoverable, so it sits under Other Current Assets rather than
    // being netted into the tax liability as a negative balance.
    expect(byCode.get(byType.get('INPUT_TAX')!.code)?.headCode).toBe('11500');
    expect(byCode.get(byType.get('OUTPUT_TAX')!.code)?.headCode).toBe('21300');
    expect(byType.get('TAX')).toMatchObject({ target: 'HEAD', code: '21300' });
  });

  it('resolves the ambiguity in Other Expenses by naming a default', () => {
    const underOther = template.ledgers.filter((l) => l.headCode === '50700');
    expect(underOther.length).toBeGreaterThan(1);
    const defaults = underOther.filter((l) => l.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe('Miscellaneous Expenses');
  });

  it('leaves the overlay empty now that the base format carries these accounts', () => {
    const base = resolveTemplate(IND_AS_TEMPLATE_KEY);
    expect(base.heads).toHaveLength(40);
    expect(base.groups).toHaveLength(41);
    expect(base.subGroups).toHaveLength(10);
    expect(base.ledgers).toHaveLength(304);
  });

  it('never leaves a mapped head without something postable under it', () => {
    for (const mapping of template.defaultMappings.filter((m) => m.target === 'HEAD')) {
      const under = template.ledgers.filter((l) => l.headCode === mapping.code);
      expect(under.length).toBeGreaterThan(0);
      if (under.length > 1) {
        expect(under.filter((l) => l.isDefault)).toHaveLength(1);
      }
    }
  });

  it('leaves no caption in the chart with nothing postable under it', () => {
    const withLedgers = new Set(template.ledgers.map((l) => l.headCode));
    const empty = template.heads.filter((h) => !withLedgers.has(h.code)).map((h) => h.code);
    expect(empty).toEqual([]);
  });
});

describe('validateTemplate rejects a broken format before anything is written', () => {
  it('catches a head pointing at a nature type that does not exist', () => {
    const broken = mutable();
    broken.heads[0].natureTypeCode = 'NOPE';
    expect(problemsFrom(broken).join(' ')).toMatch(/unknown nature type NOPE/);
  });

  it('catches a ledger pointing at a head that does not exist', () => {
    const broken = mutable();
    broken.ledgers[0].headCode = 'NOPE';
    expect(problemsFrom(broken).join(' ')).toMatch(/unknown head NOPE/);
  });

  it('catches a ledger whose group belongs to a different head', () => {
    const broken = mutable();
    // An Other Expenses ledger re-pointed at a group under Trade Payables.
    const ledger = broken.ledgers.find((l) => l.code === '507010001')!;
    ledger.groupCode = '20902';
    expect(problemsFrom(broken).join(' ')).toMatch(/belongs to head 20900/);
  });

  it('catches a ledger code outside its nature range', () => {
    const broken = mutable();
    // Sales is an income account; 999999999 is outside the IN range entirely.
    broken.ledgers.find((l) => l.code === '401010001')!.code = '999999999';
    expect(problemsFrom(broken).join(' ')).toMatch(
      /outside the IN range 400000000-499999999/
    );
  });

  it('catches a duplicated code', () => {
    const broken = mutable();
    broken.ledgers.push({ ...broken.ledgers[0] });
    expect(problemsFrom(broken).join(' ')).toMatch(/declared more than once/);
  });

  it('catches two default ledgers under one head', () => {
    const broken = mutable();
    const underInventory = broken.ledgers.filter((l) => l.headCode === '10800');
    broken.ledgers.push({
      ...underInventory[0],
      code: '108990001',
      name: 'A second inventory account',
      isDefault: true,
    });
    expect(problemsFrom(broken).join(' ')).toMatch(/more than one default ledger/);
  });

  it('catches a mapping pointing at a head with nothing under it', () => {
    const broken = mutable();
    // Every head in the shipped chart has a ledger, so the empty one is made here.
    broken.heads.push({
      code: '19900',
      name: 'A caption with nothing under it',
      natureTypeCode: broken.heads[0].natureTypeCode,
    });
    broken.defaultMappings.push({ type: 'OTHER', target: 'HEAD', code: '19900' });
    expect(problemsFrom(broken).join(' ')).toMatch(/no ledger under it/);
  });

  it('catches a mapping pointing at a ledger that does not exist', () => {
    const broken = mutable();
    broken.defaultMappings.push({ type: 'SALES', target: 'LEDGER', code: '9999' });
    expect(problemsFrom(broken).join(' ')).toMatch(/unknown ledger 9999/);
  });

  it('names the count in the summary message', () => {
    const broken = mutable();
    broken.heads[0].natureTypeCode = 'NOPE';
    expect(() => validateTemplate(broken)).toThrow(/is not usable: \d+ problem/);
  });

  it('reports every problem at once rather than only the first', () => {
    const broken = mutable();
    broken.heads[0].natureTypeCode = 'NOPE';
    broken.ledgers[0].headCode = 'ALSO-NOPE';
    expect(problemsFrom(broken).length).toBeGreaterThanOrEqual(2);
  });
});

describe('resolveTemplate', () => {
  it('refuses a template key it does not know', () => {
    expect(() => resolveTemplate('US_GAAP')).toThrow(/Unknown accounting template/);
  });
});
