/**
 * Invoice total calculation (Part B / B3.3).
 *
 * This module is PURE and is the single source of truth for invoice maths on
 * both the server and the browser preview. The server always recalculates and
 * persists its own result; the browser copy is only ever a preview.
 *
 * Rounding rule: **half away from zero** on integer minor units, applied once
 * per monetary step, never at the end of a float expression.
 */

import { applyBasisPoints, assertMinorUnits, multiplyMinor } from './money.js';

export interface InvoiceItemInput {
  description: string;
  quantity: string;
  unitPriceMinor: number;
  discountMinor?: number | null;
  taxRateBasisPoints?: number | null;
  sortOrder?: number | null;
}

export interface CalculatedLine {
  sortOrder: number;
  description: string;
  quantity: string;
  unitPriceMinor: number;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  taxRateBasisPoints: number;
  taxMinor: number;
  lineTotalMinor: number;
  /** Invoice-level discount allocated to this line (proportional, exact sum). */
  allocatedInvoiceDiscountMinor: number;
}

export interface InvoiceTotals {
  lines: CalculatedLine[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export function calculateInvoiceTotals(
  items: readonly InvoiceItemInput[],
  invoiceDiscountMinor: number,
): InvoiceTotals {
  if (items.length === 0) {
    throw new RangeError('An invoice needs at least one line item');
  }
  const documentDiscount = Math.max(0, Math.trunc(invoiceDiscountMinor || 0));
  assertMinorUnits(documentDiscount);

  const ordered = [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.sortOrder ?? a.index) - (b.item.sortOrder ?? b.index));

  const baseLines = ordered.map(({ item }) => {
    const quantity = normalizeQuantity(item.quantity);
    const unitPriceMinor = Math.trunc(item.unitPriceMinor);
    const discountMinor = Math.max(0, Math.trunc(item.discountMinor ?? 0));
    const taxRateBasisPoints = Math.trunc(item.taxRateBasisPoints ?? 0);

    assertMinorUnits(unitPriceMinor);
    assertMinorUnits(discountMinor);

    const grossMinor = multiplyMinor(unitPriceMinor, quantity);
    // A line discount may never exceed the line value.
    const effectiveDiscountMinor = Math.min(discountMinor, Math.max(0, grossMinor));
    const netMinor = grossMinor - effectiveDiscountMinor;

    return {
      description: item.description,
      quantity,
      unitPriceMinor,
      grossMinor,
      discountMinor: effectiveDiscountMinor,
      netMinor,
      taxRateBasisPoints,
      taxBeforeDocumentDiscount: applyBasisPoints(netMinor, taxRateBasisPoints),
    };
  });

  const allocated = allocateProportionally(documentDiscount, baseLines.map((line) => line.netMinor));

  const lines: CalculatedLine[] = baseLines.map((line, index) => {
    const allocatedInvoiceDiscountMinor = allocated[index] ?? 0;
    const netAfterDiscount = line.netMinor - allocatedInvoiceDiscountMinor;
    // Tax follows the discount: recomputed on the post-allocation net base.
    const taxMinor = applyBasisPoints(netAfterDiscount, line.taxRateBasisPoints);

    return {
      sortOrder: index,
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      grossMinor: line.grossMinor,
      discountMinor: line.discountMinor,
      netMinor: netAfterDiscount,
      taxRateBasisPoints: line.taxRateBasisPoints,
      taxMinor,
      lineTotalMinor: netAfterDiscount + taxMinor,
      allocatedInvoiceDiscountMinor,
    };
  });

  const subtotalMinor = lines.reduce((sum, line) => sum + line.grossMinor, 0);
  const discountMinor = lines.reduce(
    (sum, line) => sum + line.discountMinor + line.allocatedInvoiceDiscountMinor,
    0,
  );
  const taxMinor = lines.reduce((sum, line) => sum + line.taxMinor, 0);
  const totalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);

  // Invariant: the three published columns must reconcile exactly.
  if (subtotalMinor - discountMinor + taxMinor !== totalMinor) {
    throw new RangeError('Invoice totals do not reconcile');
  }

  return { lines, subtotalMinor, discountMinor, taxMinor, totalMinor };
}

/**
 * Distribute `amount` across `weights` using the largest-remainder method so
 * the allocated values sum **exactly** to `amount` with no lost minor units.
 */
export function allocateProportionally(amount: number, weights: readonly number[]): number[] {
  const count = weights.length;
  if (count === 0) return [];
  const total = Math.trunc(amount);
  if (total === 0) return new Array<number>(count).fill(0);

  const weightSum = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);

  if (weightSum <= 0) {
    // No usable weights: spread as evenly as possible.
    return evenSpread(total, count);
  }

  const exact = weights.map((weight) => (Math.max(0, weight) * total) / weightSum);
  const floored = exact.map((value) => Math.floor(value));
  let remainder = total - floored.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floored];
  for (let i = 0; remainder > 0 && i < order.length; i += 1, remainder -= 1) {
    const target = order[i];
    if (!target) break;
    result[target.index] = (result[target.index] ?? 0) + 1;
  }
  return result;
}

function evenSpread(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  let remainder = total - base * count;
  return new Array<number>(count).fill(0).map(() => {
    if (remainder > 0) {
      remainder -= 1;
      return base + 1;
    }
    return base;
  });
}

/** Accepts `2`, `"2"`, `"2.5"`, `"0.125"`; rejects negatives and >4 decimals. */
export function normalizeQuantity(quantity: string | number): string {
  const text = typeof quantity === 'number' ? String(quantity) : quantity.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(text)) {
    throw new RangeError(`Invalid quantity: ${quantity}`);
  }
  return text;
}