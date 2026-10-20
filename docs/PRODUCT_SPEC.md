# CollectFlow — Product Specification

Business rules, calculations and state transitions. Everything here is enforced
in `server/src/**` and covered by tests in `server/tests/**`; nothing is left to
the browser.

---

## 1. Money

### 1.1 Integer minor units, always

Every monetary amount is stored, transported and computed as an **integer in the
currency's minor unit** (cents, paise, fils, yen). Columns are `bigint` and are
named `*_minor` (`invoices.total_minor`, `payments.amount_minor`,
`payment_allocations.amount_minor`, `payment_adjustments.amount_minor`,
`invoice_items.unit_price_minor`).

Binary floating point is never used for a money calculation. `shared/src/money.ts`
does decimal work with scaled integer arithmetic, and `assertMinorUnits` throws
`RangeError` if an intermediate value leaves JavaScript's safe-integer range
(9 007 199 254 740 991) — far above any realistic invoice volume.

The browser preview in `client/src` calls the same `calculateInvoiceTotals`, so
what a user sees before saving and what the server persists come from one
implementation.

### 1.2 Currency exponents

`CURRENCY_EXPONENTS` in `shared/src/money.ts` carries the ISO 4217 exponent for
every zero-decimal and three-decimal currency: `JPY`, `KRW`, `VND`, `CLP`, `ISK`,
`BIF`, `PYG`, `UGX`, `XAF`, `XOF`, `XPF`, `RWF`, `GNF`, `DJF`, `KMF`, `VUV`
exponent 0; `BHD`, `IQD`, `JOD`, `KWD`, `OMR`, `TND` exponent 3; `UYW` exponent
4. Everything else uses 2. `currencyExponent('ZZZ')` returns 2 rather than
throwing.

`SUPPORTED_CURRENCIES` is the 44-code list offered in the UI. The API's
`currency` schema additionally requires a 3-letter code and a member of that
list, so an unsupported code is a `400 VALIDATION_ERROR`.

### 1.3 Rounding: half away from zero

Every monetary step rounds **half away from zero**, applied once per step and
never at the end of a float expression.

| Function | Behaviour |
| --- | --- |
| `parseToMinor('0.005','USD')` | `1` — first discarded digit ≥ 5 rounds up, regardless of sign |
| `multiplyMinor(101,'0.5')` | `51`; `multiplyMinor(-101,'0.5')` → `-51` |
| `applyBasisPoints(1, 5000)` | `1` — 0.5 of a minor unit rounds away from zero |

`multiplyMinor` and `applyBasisPoints` both compute with scaled integers
(`minor × factorInt ÷ 10^scale`) so `3 × 0.175` is exactly `0.525 → 1` and
never a binary-float artefact.

The same rule is applied in SQL by PostgreSQL's `round(numeric)`, which rounds
half away from zero for numeric types. That keeps the effective-allocation sum
and the JavaScript-side helpers consistent.

Quantities accept 1–4 decimal places (`normalizeQuantity`, regex
`^\d+(\.\d{1,4})?$`). Negatives are rejected.

### 1.4 Per-currency grouping — never mixed

CollectFlow stores **no exchange rates**. Two rules follow, and they are not
negotiable:

1. **Amounts are never added across currencies.** `groupByCurrency` returns an
   array of `{ currency, amountMinor }` sorted by code. Every dashboard metric,
   receivables bucket, customer balance and report total is an array of such
   groups, not a single number.
2. **A payment may only be allocated to an invoice in the same currency.**
   `PaymentService.assertAllocations` rejects a mismatch with a message that
   says so explicitly: *"Convert the payment first; CollectFlow never adds
   different currencies together."* There is no conversion workflow in this
   release.

`GroupByCurrency` is the only summing helper used by the report and dashboard
services.

---

## 2. Invoice totals

`calculateInvoiceTotals(items, invoiceDiscountMinor)` in
`shared/src/invoice-totals.ts` is the single source of truth, on the server and
in the browser preview. The server always recalculates and persists its own
result; a browser-submitted total is ignored (`server/src/db/schema.ts` has no
total columns that a client can write directly, and `createInvoiceSchema` has no
total fields).

### 2.1 Algorithm

Inputs: 1–100 line items, an invoice-level discount `D ≥ 0` (integer minor
units), optional per-line discount and per-line tax rate in basis points
(`10000 bp = 100%`).

**Step 1 — order.** Lines are sorted by `sortOrder`, falling back to the
submitted array index. Output `sortOrder` is the re-indexed position.

**Step 2 — per line, before the invoice-level discount.**

```
grossMinor = multiplyMinor(unitPriceMinor, quantity)      // half away from zero
lineDiscount = min(discountMinor, max(0, grossMinor))    // can never exceed the line
netMinor    = grossMinor - lineDiscount
```

**Step 3 — allocate the invoice-level discount.** `allocateProportionally(D,
netMinors)` distributes `D` across the lines in proportion to `netMinor` using
the **largest-remainder method**:

```
exact[i]  = max(0, weight[i]) * D / sum(max(0, weight))
floor[i]  = floor(exact[i])
remainder = D - sum(floor)
give one extra minor unit to each line in descending order of
  (exact[i] - floor(exact[i])), ties broken by lower line index
```

The allocated values therefore **sum exactly to `D`**: no minor unit is created
or lost. Example from `money.test.ts` — a 100-unit discount over lines of 333,
333 and 334 allocates 33/33/34; `allocateProportionally(10, [1,1,1])` returns
`[4,3,3]`.

If every weight is zero (all lines fully discounted), `evenSpread` distributes
as evenly as possible, largest remainder first.

**Step 4 — tax on the post-discount net base.** This is the important part:

```
allocatedDiscount[i] = allocateProportionally(D, netMinors)[i]
netAfterDiscount[i]  = netMinor[i] - allocatedDiscount[i]
tax[i]               = applyBasisPoints(netAfterDiscount[i], taxRateBasisPoints[i])
lineTotal[i]         = netAfterDiscount[i] + tax[i]
```

Tax is recomputed **after** the invoice-level discount is allocated, so a
discount reduces taxable value. Worked example (`money.test.ts`): one line of
10000 at 10% tax with a 5000 invoice discount gives `tax = 500` and
`total = 5500`, not `tax = 1000 / total = 6000`.

**Step 5 — invoice totals.**

```
subtotalMinor = Σ grossMinor[i]
discountMinor = Σ (lineDiscount[i] + allocatedDiscount[i])
taxMinor      = Σ tax[i]
totalMinor    = Σ lineTotal[i]
```

**Step 6 — reconcile.** The function asserts
`subtotalMinor − discountMinor + taxMinor === totalMinor` and throws
`RangeError('Invoice totals do not reconcile')` otherwise. It also throws on an
empty item list.

### 2.2 What is persisted

`invoice_items.discount_minor` stores the **sum** of the line discount and the
allocated invoice-level discount for that line (`line.discountMinor +
line.allocatedInvoiceDiscountMinor`, see `InvoiceService.create`/`update`), so
the stored line value and the invoice total stay consistent. The invoice-level
allocation itself is not stored separately; it is recomputed deterministically
from the same inputs on every recalculation.

Every create and update writes an `invoice_revisions` snapshot (invoice number,
dates, currency, notes, terms, the calculated lines and totals), unique on
`(invoice_id, version)`. The invoice PDF and the email body are both rendered
from persisted rows, never from a stale in-memory object.

### 2.3 Dates

`createInvoiceSchema` enforces `dueDate ≥ issueDate`. A draft whose due date
equals the issue date is allowed to be saved but not sent
(`markSent` rejects `dueDate < issueDate`, and the schema refuses to send one
that is not strictly later).

---

## 3. Invoice numbering

Numbers come from a **transactionally incremented per-organization sequence**,
never from `count(*)` or a max-query.

`allocateInvoiceNumber` (`server/src/services/invoice.service.ts`), executed
inside the same transaction that inserts the invoice:

```sql
UPDATE invoice_sequences
   SET next_number = next_number + 1
 WHERE organization_id = $1
RETURNING next_number - 1 AS next_number
```

- The `UPDATE … RETURNING` takes a row lock on that organization's sequence row,
  so two concurrent requests are serialised and receive two different numbers.
- The returned value is formatted as `${prefix}${number}` with the number
  zero-padded to at least 4 digits. The default prefix is `INV-`.
- The sequence row is created with the organization
  (`OrganizationService.create`).
- **Final guard:** the unique index `invoices_org_number_idx` on
  `(organization_id, invoice_number)`. A collision that somehow reached the
  insert would be rejected by the database, not by application logic.

Numbering only ever moves forward. `PATCH /settings/invoices` updates the
sequence with `greatest(current, requested)`, so an existing number can never
be reused by lowering the counter. Changing the prefix affects future numbers
only; existing invoice numbers never change.

`domain.test.ts` creates eight invoices concurrently and asserts every number is
distinct both in the returned values and in the database.

A missing sequence row produces
`409 CONFLICT — "This organization has no invoice number sequence. Restore it in
Settings."`

---

## 4. Invoice status

### 4.1 Stored lifecycle vs derived display status

Two different things, deliberately.

**Stored** (`invoices.status`, `INVOICE_STATUSES`):

| Value | Meaning |
| --- | --- |
| `draft` | Created, never sent. Fully editable. |
| `sent` | `sent_at` is set. Has an outstanding balance. |
| `partially_paid` | At least one allocation and a balance still outstanding. |
| `paid` | Balance ≤ 0. `paid_at` is set. |
| `void` | Cancelled. `voided_at` and `void_reason` are set. |

**Derived for display** (`INVOICE_DISPLAY_STATUSES`), never written to the
database:

```ts
deriveDisplayStatus(status, dueDate, balanceMinor, today)
  status === 'void'                                        -> 'void'
  status === 'paid' || balanceMinor <= 0                   -> 'paid'
  dueDate && dueDate < today
      && (status === 'sent' || status === 'partially_paid') -> 'overdue'
  otherwise                                                 -> status
```

`overdue` exists only as a computed column, computed with **today** taken in the
organization's IANA timezone (`todayIso(timezone)`). Storing it would let the
stored status and the calendar disagree, which is exactly what the
specification forbids.

The same derivation is applied in the invoice list, the invoice detail, the
dashboard, the public invoice page and the reminder scheduler, so a filter on
`status=overdue` and the badge on a row can never disagree.

### 4.2 Transitions

| From | Event | To | Notes |
| --- | --- | --- | --- |
| — | create with `saveAsDraft: true` | `draft` | |
| — | create with `saveAsDraft: false` | `sent` | `sent_at` set immediately; email is attempted |
| `draft` | `POST /invoices/:id/send` | `sent` | issues the public token if it has none |
| `draft` | `PATCH /invoices/:id` | `draft` | any financial or non-financial field |
| `sent` | `PATCH /invoices/:id` | **rejected** | `422` — void and reissue instead |
| `void` | `PATCH /invoices/:id` | **rejected** | `422` |
| `draft`/`sent` | `POST /invoices/:id/void` | `void` | only when no allocation exists |
| `sent` | payment fully allocates | `paid` | `paid_at` set |
| `sent` | partial allocation | `partially_paid` | |
| `partially_paid` | balance reaches 0 | `paid` | |
| `partially_paid` | allocation reverses | `sent` | `paid_at` cleared |
| `paid` | allocation reverses | `partially_paid` | `paid_at` cleared |
| `sent`/`partially_paid` | `POST /:id/send` again | unchanged | re-send; does **not** rotate the token |
| any | duplicate | new `draft` | copies customer, lines, currency, discount, notes, terms, payment instructions; new number |

`recomputeStatus` (`InvoiceService`) is called inside the payment transaction
after every allocation or adjustment and rewrites the status from the derived
balance. `paid` is set **only** when `totalMinor − allocated ≤ 0`; a partial
payment can never produce `paid`.

Every transition writes an `audit_events` row with a stable action name:
`invoice.created`, `invoice.created_and_sent`, `invoice.updated`, `invoice.sent`,
`invoice.resent`, `invoice.voided`, `invoice.public_link_revoked`,
`invoice.email_attempted`.

### 4.3 Void policy — deliberate

**An invoice with recorded payments cannot be voided.** `voidInvoice` sums
`payment_allocations.amount_minor` for the invoice and, if the total is above
zero, throws:

> `422 UNPROCESSABLE` — "This invoice has recorded payments. Reverse or refund
> the payment first; payment records are never erased."

The correct workflow is: add a `payment_adjustments` row (`refund`, `reversal`
or `chargeback`), let `recomputeStatus` bring the invoice back to
`partially_paid`/`sent`, then void it if appropriate. Voiding also:

- sets `status = 'void'`, `voided_at`, `void_reason` (the reason is required,
  3–500 characters),
- **revokes the public link** (`public_token_revoked_at`),
- cancels every queued reminder for the invoice with the reason
  "Invoice was voided.",
- bumps `version` and writes an audit event with the reason and invoice number.

Voiding an already-void invoice is `422`. A voided invoice's balance is reported
as `0` everywhere (list, dashboard, receivables, customer balance, public page)
and it is excluded from aging, collections and the CSV exports' outstanding
figures. The receivables report returns the excluded void count in
`excluded.voidInvoices`.

There is **no credit-note feature**. Negative invoices and negative lines are
rejected at validation (`money.nonnegative()`); a credit is represented by a
payment adjustment, which is what the void policy points at.

---

## 5. The payment ledger

### 5.1 Append-only

Nothing in the ledger is ever edited or deleted.

| Table | Role |
| --- | --- |
| `payments` | One immutable money-in event: amount, currency, method, source, `provider_name`, `provider_transaction_id`, `reference`, `paid_at`, `status`, `created_by` |
| `payment_allocations` | How much of that payment was applied to which invoice |
| `payment_adjustments` | Corrections: `refund`, `reversal` or `chargeback`, with amount, reason and external reference |

`payments.status` is one of `recorded`, `reversed`, `refunded`, `chargeback`.
It changes to the terminal value only when the total adjusted amount reaches the
full payment amount; a partial adjustment leaves the row `recorded` and reduces
the effective allocation instead.

`payments.source` is `manual` or `provider` and `method` is `bank_transfer`,
`cash`, `cheque`, `card`, `provider` or `other`. Manual payments are always
labelled manual. The UI and the API never describe a manually recorded payment
as provider-confirmed.

`recordManual` requires `fundsReceivedConfirmed: true` (a literal in
`recordPaymentSchema`, so omitting it is a `400`), rejects a future `paidAt`,
and rejects a currency or customer mismatch.

### 5.2 Allocation rules

- **Automatic allocation** (no explicit allocations): oldest-first by
  `issue_date`, then `invoice_number`, across the customer's `sent` and
  `partially_paid` invoices in the same currency with a positive balance. If the
  amount exceeds what is open, the payment is rejected with
  `422` and the covered amount is named. There is no unapplied-credit bucket in
  this release: over-allocation is refused with an explanation, as the
  specification allows.
- **Explicit allocations** must sum **exactly** to the payment amount for
  `recordManual`; the Zod `superRefine` and the service both check it and
  return `422` naming both figures. For `allocate` on an existing payment, the
  new allocations must not exceed the unallocated remainder.
- Each allocation is validated against the invoice: same organization, same
  customer, same currency, not void, and not more than the invoice's
  outstanding balance (excluding the payment being re-allocated).
- The payment, its allocations, every affected invoice's recomputed status and
  the audit event are written in **one transaction**.

### 5.3 Effective allocation — the rule that matters

When part of a payment is refunded, reversed or charged back, the amount applied
to each invoice shrinks proportionally. The rule, implemented once in
`server/src/db/balance-sql.ts` and used everywhere:

```
effectiveAllocated(invoice)
  = Σ over that invoice's allocations of

      round(
        allocation.amount
        × ( payment.amount − LEAST(totalAdjustments, payment.amount) )
        / payment.amount
      )
```

rounded **half away from zero per allocation** (PostgreSQL `round(numeric)`).

**Why proportional, and why scaled by the payment amount.** A single payment can
be split across several invoices. Subtracting the raw adjustment from each
allocation would over-reverse the invoices the money did not fund, and would let
the total effective allocation go negative when the adjustment exceeds a single
allocation. Scaling each allocation by the payment's retained fraction
`1 − adjustments/payment.amount` distributes the reversal in exactly the
proportion each invoice received, and `LEAST(totalAdjustments, payment.amount)`
guarantees the fraction is within `[0, 1]`, so an effective allocation is never
negative and never exceeds the allocation.

Worked example. A payment of 10000 is split 6000 to invoice A and 4000 to
invoice B. A 3000 reversal leaves a retained fraction of
`(10000 − 3000)/10000 = 0.7`. Invoice A becomes `round(6000 × 0.7) = 4200`
and invoice B becomes `round(4000 × 0.7) = 2800`; the total is exactly 7000, not
7000 ± 2. A second reversal adjusts the same fraction again, so the sequence is
deterministic and order-independent.

`balance = totalMinor − effectiveAllocated`, clamped to 0 for void invoices.

**The same SQL fragment is the only balance definition in the product.** The
invoice list, the invoice detail, the dashboard, the receivables and collections
reports, the customer balances, every CSV export and the public invoice page all
call `effectiveAllocatedSql` / `allocatedForInvoiceTable` from
`server/src/db/balance-sql.ts`. There is no cached `paid_minor` column that
could drift. See the second named rule in
[ARCHITECTURE.md](ARCHITECTURE.md).

One deliberate exception: `InvoiceService.detail` computes `paidMinor` by
summing the raw allocation rows it already loaded for the allocation list, and
the PDF renders `paidMinor = 0` / `balance = total` because a document is a
statement of what was invoiced. Both are documented here rather than hidden.

### 5.4 Provider payments

`recordProviderPayment` deduplicates on
`(organization_id, provider_name, provider_transaction_id)`, backed by the
partial unique index `payments_provider_txn_idx` on
`(organization_id, provider_name, provider_transaction_id) WHERE source =
'provider'`. Replaying the same provider event returns the existing payment id
with `deduplicated: true` and never creates a second row — asserted in
`domain.test.ts`.

---

## 6. Reminders

### 6.1 Idempotency key

Every reminder is materialised as a `reminder_logs` row whose
`idempotency_key` is

```
(organizationId, invoiceId, ruleId, targetDate)
```

joined with `:` — for example
`018f…-org:018f…-invoice:018f…-rule:2026-03-14`. `reminder_logs_idempotency_idx`
is a unique index on that column, and the insert uses
`ON CONFLICT DO NOTHING`, so:

- running the scheduler twice creates nothing new,
- two workers scheduling concurrently cannot double-send,
- retrying after a failure cannot produce a second email.

The `email.deliver` job for a reminder carries its own idempotency key
(`email-deliver:<messageId>`), and the email outbox row carries
`reminder:<organizationId>:<invoiceId>:<ruleId>:<targetDate>`.

Invoice sends use a separate, deliberately coarser key,
`${organizationId}:invoice_sent:${invoiceId}:${YYYY-MM-DD}`, so a resend on the
same day cannot spam a customer.

### 6.2 Scheduling

`scheduleDueReminders` runs for one organization and considers invoices with
status `sent` or `partially_paid` and a positive balance.

For each enabled rule:

- `targetDate = dueDate + offsetDays`. `offsetDays` is negative for `before`,
  `0` for `on`, positive for `after`. The four defaults created with an
  organization are *Before due (−3)*, *On due date (0)*, *After due (7)* and
  *After due (14)* — **all disabled by default**.
- Invoices with no `due_date` are skipped: there is nothing to count from.
- A `targetDate` more than 60 days in the future is skipped (the horizon).
- A `targetDate` more than 3 days in the past is skipped. CollectFlow does not
  send a backlog of stale reminders on first enablement.

Skipped and counted reasons: the customer opted out, the customer has no email
address, the invoice has no due date, and the target window is outside the
horizon or grace period.

### 6.3 Timezone and quiet hours

- "Today", the due-date comparison and every target date are computed in the
  **organization's IANA timezone** (`todayIso(organization.timezone)`,
  `Intl.DateTimeFormat` with an explicit `timeZone`). Timezone names are
  validated on save (`isValidTimeZone`) and at organization creation. Daylight
  saving transitions are therefore handled by the platform, not by hard-coded
  offsets.
- The nominal send instant for a target date is **09:00 UTC**.
- Quiet hours are configured per organization as `quietHoursStart` /
  `quietHoursEnd` (`HH:MM`, nullable). `resolveSendTime` converts the candidate
  instant into the organization's local wall clock
  (`minutesSinceMidnightInZone`) and, if it falls inside the quiet window,
  moves it forward to the end of the window (handling windows that wrap past
  midnight). This is the one place where the nominal instant is a fixed UTC time
  rather than a local time; it is stated here so nobody has to reverse-engineer
  it.
- `remindersPaused` (default **`true`**) stops scheduling globally.

### 6.4 Opt-out

`customers.reminder_opt_out` (default `false`) suppresses every reminder for
that customer. `POST /:organizationId/customers/:customerId/reminder-opt-out`
sets it; `POST .../:id/archive` also archives them. The scheduler counts the
skip and sends nothing.

### 6.5 Cancellation

When an invoice becomes `paid` or `void`, every `queued` reminder for it is
marked `skipped` with a safe reason — on void ("Invoice was voided."), on a
recorded payment ("Invoice was paid." or "Payment recorded."), and from the
`invoices.reconcile` job ("Invoice is already paid."). No reminder is sent for a
settled or cancelled invoice.

### 6.6 Status vocabulary

`reminder_logs.status` is one of `queued`, `sent`, `delivered`, `bounced`,
`failed`, `skipped`. CollectFlow only ever **writes** `queued`, `sent` and
`skipped`; `delivered`/`bounced` exist in the vocabulary for a future provider
callback and are never asserted without provider evidence. Each row records
`scheduled_for`, `sent_at`, `provider_message_id`, `failure_code`,
`safe_failure_message` and `attempt_count` — no credentials.

### 6.7 Preview

`GET /:organizationId/reminders/preview/:invoiceId` returns the customer, the
balance computed from the effective-allocation SQL, whether they have opted out,
and each rule with its `targetDate` — so an operator can see what *would* be
sent before enabling anything. Templates are not editable in the UI in this
release; the four defaults are seeded per organization.

---

## 7. Public invoice links

### 7.1 The token

| Property | Value |
| --- | --- |
| Entropy | 32 bytes (256 bits) from `node:crypto.randomBytes`, base64url |
| Shape | `^[A-Za-z0-9_-]{32,64}$` — anything else is rejected as `404` without a database query |
| Storage | Only `SHA-256(token)` in `invoices.public_token_hash` (unique index `invoices_public_token_idx`) |
| Issued | On the first `markSent` of an invoice, and only then |
| Rotation | `markSent(..., { rotatePublicLink: true })` replaces the hash; an ordinary resend does **not** rotate it |
| Revocation | `POST /:organizationId/invoices/:invoiceId/public-link/revoke` sets `public_token_revoked_at`; voiding an invoice also revokes it |
| Expiry | No time-based expiry — revocation is the control |
| Rate limit | 30 requests per minute per IP, with a `RATE_LIMITED` envelope |
| Lookup | `WHERE public_token_hash = sha256($token) AND public_token_revoked_at IS NULL` |

A revoked or unknown token returns the same `404` message, so a revoked link is
indistinguishable from a wrong one.

### 7.2 Exactly what the link exposes

`GET /api/v1/public/invoices/:token` — unauthenticated, no session, no
organization id:

| Key | Contents |
| --- | --- |
| `organization` | `name`, and `address` = `[addressLine1, city, countryCode]` with empty values dropped |
| `customer` | `name` **only** |
| `invoice` | `number`, `issueDate`, `dueDate`, `currency`, `status` (derived display status), `subtotal`, `discount`, `tax`, `total`, `paid`, `balance` (decimal strings in the invoice currency), `notes`, `terms`, `paymentInstructions` |
| `items[]` | `description`, `quantity`, `unitPrice`, `amount` |
| `onlinePayment` | `{ available: false, reason: "No online payment provider is configured for this organization. Please use the payment instructions on the invoice." }` |

Never exposed: the invoice id, the organization id, the customer id, the
customer's email address, phone number, notes, tax identifier or billing
address, the allocation list, audit events, payment records, internal ids of any
kind, or the token hash. `api.test.ts` asserts the response contains neither the
customer id nor the customer email, and that `customer.email` is `undefined`.

`balance` on the public page uses the same effective-allocation SQL as every
other surface, so a customer can never be shown a balance different from the
one the operator sees.

The link is `APP_URL/i/<token>`. The web client serves the invoice at
`/public/invoices/:token`.

---

## 8. Email truthfulness

CollectFlow never claims an external action succeeded unless the external
service confirmed it.

| Term | Meaning | Where |
| --- | --- | --- |
| `queued` | Persisted in `email_messages`, not yet handed to a provider | `EmailService.queue` |
| `sent` | **The provider accepted the message for delivery.** Nothing more. | `SmtpEmailAdapter.send` resolving |
| `delivered` | **Never written.** Plain SMTP has no delivery receipt. | — |

- The adapter contract has `deliversMessages` (a provider will really try) and
  `accepted` (the provider took the message). Both are separate from the
  recorded status.
- The outbox endpoint returns an explicit note:
  *"A message marked `sent` means the email provider accepted it for delivery.
  SMTP does not report delivery, so CollectFlow never claims an email was
  delivered."*
- Every message is persisted **before** an attempt, so an operator can see what
  was queued, what the provider accepted, and what failed, with
  `provider_message_id` and a redacted failure message.
- The test message says the same thing to the recipient: *"If you received it,
  the email provider accepted the message. CollectFlow cannot confirm delivery
  because plain SMTP does not report it."*
- The PDF footer states that CollectFlow is not a bank, payment processor or tax
  adviser, and that tax figures are recorded as entered by the issuer. The
  email template footer says the same.
- Failure codes: `not_configured`, `temporary`, `permanent_recipient`,
  `auth_failed`, `provider_error`. `temporary` and `provider_error` are
  retryable; the rest are permanent and are not retried.
- Sending is queued, never held open in a web request: `POST /:id/send` enqueues
  the outbox row and returns; the `email.deliver` job does the delivery.

A "viewed" event in the invoice timeline is **not** implemented. There is no
open-tracking, so the timeline never claims the customer read the invoice.

---

## 9. Payment provider integration — the honest status

**No payment-provider adapter ships in this release.**

What exists:

| Piece | State |
| --- | --- |
| Storage | `integrations` row per `(organization_id, provider='payment_provider')`, status `not_configured` until credentials are stored |
| Encryption | AES-256-GCM at rest via `ENCRYPTION_KEY`; masked display; refuses to store without a key (`422` naming `ENCRYPTION_KEY`) |
| UI | An IntegrationCard labelled "Online payment provider" with the status badge **Not connected**, a setup guide, a capabilities list and the limitations below (`client/src/pages/Integrations.tsx`) |
| Verify action | `POST /:organizationId/integrations/payment_provider/test` always answers `ok: false` with *"No online payment provider is configured. CollectFlow cannot verify a provider it has no credentials for."* and records `status: not_configured` |
| Webhook route | `POST /api/v1/webhooks/payments/:provider` records the event with `status: 'rejected'`, `error_code: 'provider_not_configured'` and a payload hash, then returns `503 INTEGRATION_UNAVAILABLE` — *"No payment provider adapter is configured, so this webhook cannot be verified or processed. Nothing has been recorded as paid."* |
| Public page | `onlinePayment.available` is always `false` with a reason |
| Ledger support | `recordProviderPayment` with provider-transaction deduplication, so a future adapter has a safe insertion point |

What is **not** implemented:

- Provider SDK or API client of any kind.
- Webhook signature verification.
- Order/payment creation, hosted checkout pages, or return-URL handling.
- Any code path that marks an invoice `paid` from a provider.
- A credentials form in the UI. The `PUT /:organizationId/integrations/:provider`
  API exists and is permission-checked, but no screen calls it, so credentials
  can only be stored through the API.

**Why no adapter ships.** Merchant account approval, settlement schedules,
platform fees and API access are per-provider and per-country, and none of them
can be obtained or tested from a build machine. Shipping an untested adapter
would mean shipping code that has never exchanged a signature with a real
provider — precisely the "never claim an external action succeeded" failure the
specification forbids. The specification's MVP boundary is explicit: *"one real
payment-provider adapter only if account credentials are available."* They were
not, so the boundary is built and labelled instead.

**Merchant approval and fees are outside CollectFlow** in every case, and that
sentence is shown in the product.

Manual recording (bank transfer, cash, cheque, card in-store) is fully
implemented, clearly labelled manual, and works with no provider configured.
PDF download and manual payment recording also work with email disabled.

---

## 10. Roles and actions in the product

| Action | Required permission | Roles that hold it |
| --- | --- | --- |
| Create invoice, duplicate, download PDF | `invoice.create` | owner, admin, member |
| Edit a draft, void an invoice | `invoice.edit` | owner, admin, member |
| Send / resend, revoke the public link | `invoice.send` | owner, admin |
| Record / allocate / adjust a payment | `payment.record` | owner, admin |
| Export CSV | `report.export` | owner, admin, member |
| Create / edit / archive customers, set reminder opt-out | `customer.manage` | owner, admin, member |
| Organization, invoice settings, reminder rules | `settings.manage` | owner, admin |
| Store / test / disconnect integrations | `integration.manage` | owner, admin |
| Invite, change role, remove members | `member.manage` | owner, admin |
| Read the audit log | `audit.view` | owner, admin |
| Transfer ownership | `ownership.transfer` | owner |

A `viewer` holds no permissions: read-only. A member **cannot** mark an invoice
paid — that requires `payment.record`, and `POST /payments/manual` demands an
amount, a date, a method, an optional reference and an explicit
`fundsReceivedConfirmed: true`, then writes a `payment.recorded_manual` audit
event in the same transaction.

Manual payment recording can be switched off per organization
(`allowManualPayments`, default `true`). When it is off the endpoint returns
`422` telling the user an owner or admin can enable it in Settings.

---

## 11. Metric definitions

The dashboard returns these definitions alongside the numbers, and the UI
displays them.

| Metric | Definition |
| --- | --- |
| Outstanding | Total of `sent` and `partially_paid` invoices that still have a balance, excluding void invoices, grouped per currency |
| Overdue | The outstanding balance of `sent`/`partially_paid` invoices whose `due_date` is before today in the organization timezone |
| Collected this month | `payments` with `status = 'recorded'` and `paid_at` inside the current calendar month. Manual and provider payments both included. |
| Invoices awaiting payment | Count of `sent`/`partially_paid` invoices with a balance above zero |
| Drafts / Customers | Row counts, not sums |
| Currency grouping | Amounts are grouped per currency and never added together, because no exchange rates are stored |

**Empty is empty.** With no records, every metric is an empty array or a zero
count. No chart, trend or comparison is fabricated, and no trend is shown
without a real comparison window.

Reports state their exclusions explicitly: void invoices are excluded from every
collected and outstanding figure, and reversed/refunded/charged-back payments
keep their original row and are visible through the adjustment list.

Aging buckets (`GET /reports/receivables`): `current` (not yet due or no due
date), `1_30`, `31_60`, `61_90`, `90_plus`, computed from `asOf`
(default today, UTC) minus `due_date`, ignoring invoices with a balance ≤ 0.
Each bucket returns a total, an invoice count **and** a `byCurrency` array, so
a multi-currency organization is never shown a misleading cross-currency total.
`byCustomer` is capped at 50 rows; the dashboard's follow-up list at 8.

CSV exports are permission-checked (`report.export`), written to the audit log
with the dataset and row count, rate-limited by the global limiter, and
formula-escaped. Datasets: `invoices`, `customers`, `payments`, `aging`,
`reminders`.