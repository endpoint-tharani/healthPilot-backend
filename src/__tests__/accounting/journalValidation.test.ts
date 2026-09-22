import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { validateJournalLines } from '../../services/accounting/journal.service';
import { accountingEventKey } from '../../constants/accounting';

/**
 * The double-entry rules, tested without a database.
 *
 * These are the invariants the whole module rests on, so they are checked here as
 * pure functions rather than only through a posting: a test that has to build a
 * company and a chart of accounts to prove that a debit and a credit cannot share
 * a line is a test nobody runs often enough to catch a regression.
 *
 * Every rule below is also a CHECK constraint in Postgres. These tests assert the
 * message a person sees; the database is what makes the rule unbypassable.
 */

const A = 'ledger-a';
const B = 'ledger-b';

describe('validateJournalLines', () => {
  it('accepts a balanced two-line entry', () => {
    const result = validateJournalLines([
      { ledgerId: A, debit: '100.00' },
      { ledgerId: B, credit: '100.00' },
    ]);

    expect(result.totalDebit.toFixed(2)).toBe('100.00');
    expect(result.totalCredit.toFixed(2)).toBe('100.00');
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].lineNumber).toBe(1);
    expect(result.lines[1].lineNumber).toBe(2);
  });

  it('accepts a balanced entry with several lines on one side', () => {
    // The supplier invoice shape: goods and tax debited, one payable credited.
    const result = validateJournalLines([
      { ledgerId: A, debit: '35000.00' },
      { ledgerId: B, debit: '1750.00' },
      { ledgerId: 'ap', credit: '36750.00' },
    ]);

    expect(result.totalDebit.toFixed(2)).toBe('36750.00');
    expect(result.totalCredit.toFixed(2)).toBe('36750.00');
  });

  it('rejects an entry with fewer than two lines', () => {
    expect(() => validateJournalLines([{ ledgerId: A, debit: '100.00' }])).toThrow(
      /at least two lines/i
    );
    expect(() => validateJournalLines([])).toThrow(/at least two lines/i);
  });

  it('rejects an unbalanced entry and names the difference', () => {
    expect(() =>
      validateJournalLines([
        { ledgerId: A, debit: '100.00' },
        { ledgerId: B, credit: '90.00' },
      ])
    ).toThrow(/does not balance.*100\.00.*90\.00.*10\.00/is);
  });

  it('rejects a line carrying both a debit and a credit', () => {
    expect(() =>
      validateJournalLines([
        { ledgerId: A, debit: '100.00', credit: '100.00' },
        { ledgerId: B, credit: '100.00' },
      ])
    ).toThrow(/either a debit or a credit, never both/i);
  });

  it('rejects a line carrying neither a debit nor a credit', () => {
    expect(() =>
      validateJournalLines([
        { ledgerId: A, debit: '100.00' },
        { ledgerId: B, credit: '100.00' },
        { ledgerId: 'c' },
      ])
    ).toThrow(/must carry a debit or a credit/i);
  });

  it('rejects a negative amount rather than treating it as the other side', () => {
    // A negative debit is a credit wearing the wrong sign. Accepting it would
    // balance the entry while unbalancing every report that sums the two columns
    // separately.
    expect(() =>
      validateJournalLines([
        { ledgerId: A, debit: '-100.00' },
        { ledgerId: B, credit: '-100.00' },
      ])
    ).toThrow(/must not be negative/i);
  });

  it('rejects an entry that totals zero on both sides', () => {
    expect(() =>
      validateJournalLines([
        { ledgerId: A, debit: '0' },
        { ledgerId: B, credit: '0' },
      ])
    ).toThrow(/must carry a debit or a credit/i);
  });

  it('rejects a line with no ledger account', () => {
    expect(() =>
      validateJournalLines([
        { ledgerId: '', debit: '100.00' },
        { ledgerId: B, credit: '100.00' },
      ])
    ).toThrow(/ledger account is required/i);
  });

  it('names the offending line number', () => {
    expect(() =>
      validateJournalLines([
        { ledgerId: A, debit: '100.00' },
        { ledgerId: B, credit: '50.00' },
        { ledgerId: 'c', debit: '25.00', credit: '25.00' },
      ])
    ).toThrow(/Line 3/);
  });
});

describe('decimal precision', () => {
  it('keeps money exact where binary floating point would not', () => {
    // 0.1 + 0.2 is 0.30000000000000004 as a JS number, which would leave this
    // entry a fraction of a paisa out and refuse a posting that is in fact correct.
    const result = validateJournalLines([
      { ledgerId: A, debit: '0.10' },
      { ledgerId: A, debit: '0.20' },
      { ledgerId: B, credit: '0.30' },
    ]);

    expect(result.totalDebit.toFixed(2)).toBe('0.30');
    expect(result.totalDebit.equals(result.totalCredit)).toBe(true);
  });

  it('rounds half-up to two places, as the rest of the ERP does', () => {
    const result = validateJournalLines([
      { ledgerId: A, debit: '162.505' },
      { ledgerId: B, credit: '162.505' },
    ]);

    expect(result.totalDebit.toFixed(2)).toBe('162.51');
  });

  it('holds a figure larger than a float can represent exactly', () => {
    const big = '99999999.99';
    const result = validateJournalLines([
      { ledgerId: A, debit: big },
      { ledgerId: B, credit: big },
    ]);

    expect(result.totalDebit.toFixed(2)).toBe(big);
  });

  it('accepts Prisma.Decimal instances as well as strings', () => {
    const result = validateJournalLines([
      { ledgerId: A, debit: new Prisma.Decimal('3412.50') },
      { ledgerId: B, credit: new Prisma.Decimal('3250.00') },
      { ledgerId: 'tax', credit: new Prisma.Decimal('162.50') },
    ]);

    expect(result.totalDebit.toFixed(2)).toBe('3412.50');
    expect(result.totalCredit.toFixed(2)).toBe('3412.50');
  });
});

describe('accountingEventKey', () => {
  it('is stable for the same event and source', () => {
    expect(accountingEventKey('SALES', 'doc-1')).toBe(accountingEventKey('SALES', 'doc-1'));
  });

  it('separates the two journals one dispensing raises', () => {
    // The sale and the cost of the goods sold are different events against the
    // same document, so they must not collide on the idempotency key.
    expect(accountingEventKey('SALES', 'doc-1')).not.toBe(accountingEventKey('COGS', 'doc-1'));
  });

  it('separates the same event on different documents', () => {
    expect(accountingEventKey('SALES', 'doc-1')).not.toBe(accountingEventKey('SALES', 'doc-2'));
  });
});
