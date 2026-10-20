/**
 * Effective payment allocation SQL (Part B / B4 "recalculate invoice balance
 * from allocations and reversals").
 *
 * `payment_allocations` records what a payment was applied to. When part of a
 * payment is refunded, reversed or charged back, the applied amount shrinks.
 *
 * Rule (documented in docs/PRODUCT_SPEC.md):
 *   effective allocation for an invoice
 *     = SUM over that invoice's allocations of
 *         allocation.amount
 *         x (payment.amount - LEAST(totalAdjustments, payment.amount))
 *         / payment.amount
 *   rounded half away from zero per allocation.
 *
 * Scaling by the payment amount (rather than subtracting the raw adjustment)
 * keeps a payment split across several invoices correct on each of them and
 * guarantees the effective amount is never negative.
 */

import type { SQL, SQLWrapper } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

/**
 * Effective allocated minor units for an invoice.
 * `invoiceId` must be a SQL expression that resolves to the invoice id.
 */
export function effectiveAllocatedSql(invoiceId: SQLWrapper, organizationId: SQLWrapper): SQL<number> {
  return sql<number>`(
    select coalesce(sum(
      round(
        pa.amount_minor::numeric
        * (p.amount_minor - least(coalesce(adj.reversed_minor, 0), p.amount_minor))::numeric
        / p.amount_minor::numeric
      )
    ), 0)::bigint
      from payment_allocations pa
      join payments p
        on p.id = pa.payment_id
       and p.organization_id = pa.organization_id
      left join (
        select payment_id, sum(amount_minor) as reversed_minor
          from payment_adjustments
         group by payment_id
      ) adj on adj.payment_id = pa.payment_id
     where pa.invoice_id = ${invoiceId}
       and pa.organization_id = ${organizationId}
  )`;
}

/** Convenience wrapper for the common "row of `invoices`" case. */
export function allocatedForInvoiceTable(organizationId: string): SQL<number> {
  return effectiveAllocatedSql(sql`invoices.id`, sql`${organizationId}`);
}