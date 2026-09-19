import { Prisma } from '@prisma/client';

export type DecimalInput = Prisma.Decimal | string | number;

export const D = Prisma.Decimal;
export const ZERO = new Prisma.Decimal(0);

export function dec(value: DecimalInput): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/** Money is stored as Decimal(12,2); every monetary result is rounded half-up to 2dp. */
export function money(value: DecimalInput): Prisma.Decimal {
  return dec(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export function sum(values: DecimalInput[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((acc, v) => acc.plus(dec(v)), ZERO);
}

export interface LineTotals {
  subtotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** Server-side line maths. Client-supplied totals are never trusted. */
export function calculateLineTotals(
  quantity: DecimalInput,
  unitPrice: DecimalInput,
  taxRatePercent: DecimalInput
): LineTotals {
  const subtotal = money(dec(quantity).times(dec(unitPrice)));
  const taxAmount = money(subtotal.times(dec(taxRatePercent)).dividedBy(100));
  return { subtotal, taxAmount, total: money(subtotal.plus(taxAmount)) };
}

export function totalsFromLines(lines: LineTotals[]): LineTotals {
  const subtotal = money(sum(lines.map((l) => l.subtotal)));
  const taxAmount = money(sum(lines.map((l) => l.taxAmount)));
  return { subtotal, taxAmount, total: money(subtotal.plus(taxAmount)) };
}

export const isPositive = (v: DecimalInput) => dec(v).greaterThan(0);
export const isNegative = (v: DecimalInput) => dec(v).lessThan(0);
