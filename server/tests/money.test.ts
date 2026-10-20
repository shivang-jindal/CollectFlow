import { describe, expect, it } from 'vitest';

import {
  applyBasisPoints,
  currencyExponent,
  deriveDisplayStatus,
  formatMinorAsDecimal,
  groupByCurrency,
  multiplyMinor,
  parseToMinor,
  allocateProportionally,
} from '@collectflow/shared';

import { calculateInvoiceTotals } from '@collectflow/shared';

describe('money: minor units', () => {
  it('knows the ISO 4217 exponent for common currencies', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('ZZZ')).toBe(2);
  });

  it('parses decimal strings into integer minor units', () => {
    expect(parseToMinor('1234.56', 'USD')).toBe(123456);
    expect(parseToMinor('0.005', 'USD')).toBe(1);
    expect(parseToMinor('10', 'JPY')).toBe(10);
    expect(parseToMinor('1.2345', 'KWD')).toBe(1235);
  });

  it('rejects malformed amounts instead of guessing', () => {
    expect(parseToMinor('1,234.56', 'USD')).toBeNull();
    expect(parseToMinor('abc', 'USD')).toBeNull();
    expect(parseToMinor('', 'USD')).toBeNull();
  });

  it('formats minor units back to a decimal string', () => {
    expect(formatMinorAsDecimal(123456, 'USD')).toBe('1234.56');
    expect(formatMinorAsDecimal(1000, 'JPY')).toBe('1000');
    expect(formatMinorAsDecimal(-500, 'USD')).toBe('-5.00');
  });

  it('multiplies by a decimal factor with half-away-from-zero rounding', () => {
    expect(multiplyMinor(333, '3')).toBe(999);
    expect(multiplyMinor(1000, '0.175')).toBe(175);
    expect(multiplyMinor(101, '0.5')).toBe(51);
    expect(multiplyMinor(-101, '0.5')).toBe(-51);
  });

  it('applies basis-point rates exactly', () => {
    expect(applyBasisPoints(10000, 1800)).toBe(1800);
    expect(applyBasisPoints(333, 1800)).toBe(60);
    expect(applyBasisPoints(1, 5000)).toBe(1); // 0.5 rounds away from zero
  });

  it('never sums different currencies together', () => {
    expect(
      groupByCurrency([
        { currency: 'USD', amountMinor: 100 },
        { currency: 'EUR', amountMinor: 250 },
        { currency: 'USD', amountMinor: 50 },
      ]),
    ).toEqual([
      { currency: 'EUR', amountMinor: 250 },
      { currency: 'USD', amountMinor: 150 },
    ]);
  });
});

describe('invoice totals', () => {
  it('calculates quantity, discount and tax in integer minor units', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'Design', quantity: '2', unitPriceMinor: 50000, taxRateBasisPoints: 2000 },
        { description: 'Hosting', quantity: '12', unitPriceMinor: 1000 },
      ],
      0,
    );

    expect(totals.subtotalMinor).toBe(112000);
    expect(totals.discountMinor).toBe(0);
    expect(totals.taxMinor).toBe(20000);
    expect(totals.totalMinor).toBe(132000);
  });

  it('allocates an invoice-level discount proportionally and exactly', () => {
    const totals = calculateInvoiceTotals(
      [
        { description: 'A', quantity: '1', unitPriceMinor: 333 },
        { description: 'B', quantity: '1', unitPriceMinor: 333 },
        { description: 'C', quantity: '1', unitPriceMinor: 334 },
      ],
      100,
    );

    const allocated = totals.lines.map((line) => line.allocatedInvoiceDiscountMinor);
    expect(allocated.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(totals.totalMinor).toBe(1000 - 100);
    expect(totals.subtotalMinor - totals.discountMinor + totals.taxMinor).toBe(totals.totalMinor);
  });

  it('reduces tax when an invoice-level discount is applied', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Service', quantity: '1', unitPriceMinor: 10000, taxRateBasisPoints: 1000 }],
      5000,
    );
    expect(totals.taxMinor).toBe(500);
    expect(totals.totalMinor).toBe(5500);
  });

  it('never lets a line discount exceed the line value', () => {
    const totals = calculateInvoiceTotals(
      [{ description: 'Service', quantity: '1', unitPriceMinor: 1000, discountMinor: 9999 }],
      0,
    );
    expect(totals.lines[0]!.discountMinor).toBe(1000);
    expect(totals.totalMinor).toBe(0);
  });

  it('rejects an empty invoice and invalid quantities', () => {
    expect(() => calculateInvoiceTotals([], 0)).toThrow();
    expect(() =>
      calculateInvoiceTotals([{ description: 'x', quantity: '-1', unitPriceMinor: 100 }], 0),
    ).toThrow();
  });

  it('distributes a remainder without losing a single minor unit', () => {
    const allocated = allocateProportionally(10, [1, 1, 1]);
    expect(allocated).toEqual([4, 3, 3]);
    expect(allocated.reduce((sum, value) => sum + value, 0)).toBe(10);
  });
});

describe('invoice status derivation', () => {
  it('treats overdue as derived, never stored', () => {
    expect(deriveDisplayStatus('sent', '2024-01-01', 500, '2024-02-01')).toBe('overdue');
    expect(deriveDisplayStatus('sent', '2024-03-01', 500, '2024-02-01')).toBe('sent');
    expect(deriveDisplayStatus('partially_paid', '2024-01-01', 1, '2024-02-01')).toBe('overdue');
  });

  it('keeps void and paid terminal', () => {
    expect(deriveDisplayStatus('void', '2024-01-01', 100, '2024-02-01')).toBe('void');
    expect(deriveDisplayStatus('paid', '2024-01-01', 0, '2024-02-01')).toBe('paid');
  });
});