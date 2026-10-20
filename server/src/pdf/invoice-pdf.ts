/**
 * Invoice PDF (Part B / B3.3, B8).
 *
 * The PDF is rendered from the persisted invoice snapshot, so the document and
 * the emailed content always agree with what is stored. No JavaScript from the
 * target is involved and no network request is made.
 */

import { and, eq } from 'drizzle-orm';
import PDFDocument from 'pdfkit';

import { formatMinorAsDecimal } from '@collectflow/shared';

import type { AppDatabase } from '../db/client.js';
import { customers, invoiceItems, invoices, organizations } from '../db/schema.js';
import { notFound } from '../errors.js';

export interface InvoicePdfData {
  organization: {
    name: string;
    addressLines: string[];
    taxIdentifier: string | null;
    email: string | null;
  };
  customer: { name: string; addressLines: string[]; taxIdentifier: string | null };
  invoice: {
    invoiceNumber: string;
    issueDate: string;
    dueDate: string | null;
    currency: string;
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
    paidMinor: number;
    balanceMinor: number;
    notes: string | null;
    terms: string | null;
    paymentInstructions: string | null;
    taxLabel: string;
  };
  items: Array<{
    description: string;
    quantity: string;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }>;
}

export async function loadInvoiceForPdf(
  db: AppDatabase,
  organizationId: string,
  invoiceId: string,
): Promise<InvoicePdfData> {
  const invoice = (
    await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
      .limit(1)
  )[0];
  if (!invoice) throw notFound('Invoice');

  const organization = (
    await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1)
  )[0];
  const customer = (
    await db.select().from(customers).where(eq(customers.id, invoice.customerId)).limit(1)
  )[0];
  const items = await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(invoiceItems.sortOrder);

  return {
    organization: {
      name: organization?.name ?? 'Organization',
      addressLines: [
        organization?.addressLine1,
        organization?.addressLine2,
        [organization?.city, organization?.region].filter(Boolean).join(', ') || null,
        organization?.postalCode,
        organization?.countryCode,
      ].filter((line): line is string => Boolean(line)),
      taxIdentifier: organization?.taxIdentifier ?? null,
      email: null,
    },
    customer: {
      name: customer?.name ?? 'Customer',
      addressLines: [
        customer?.billingAddress?.line1,
        customer?.billingAddress?.line2,
        [customer?.billingAddress?.city, customer?.billingAddress?.region]
          .filter(Boolean)
          .join(', ') || null,
        customer?.billingAddress?.postalCode,
        customer?.billingAddress?.countryCode,
      ].filter((line): line is string => Boolean(line)),
      taxIdentifier: customer?.taxIdentifier ?? null,
    },
    invoice: {
      invoiceNumber: invoice.invoiceNumber,
      issueDate: toDate(invoice.issueDate),
      dueDate: invoice.dueDate ? toDate(invoice.dueDate) : null,
      currency: invoice.currency,
      subtotalMinor: Number(invoice.subtotalMinor),
      discountMinor: Number(invoice.discountMinor),
      taxMinor: Number(invoice.taxMinor),
      totalMinor: Number(invoice.totalMinor),
      paidMinor: 0,
      balanceMinor: Number(invoice.totalMinor),
      notes: invoice.notes,
      terms: invoice.terms,
      paymentInstructions: invoice.paymentInstructions,
      taxLabel: invoice.taxLabel ?? 'Tax',
    },
    items: items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPriceMinor: Number(item.unitPriceMinor),
      lineTotalMinor: Number(item.lineTotalMinor),
    })),
  };
}

export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: {
    Title: `Invoice ${data.invoice.invoiceNumber}`,
    Author: data.organization.name,
    Creator: 'CollectFlow',
  } });

  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const money = (minor: number) => `${formatMinorAsDecimal(minor, data.invoice.currency)} ${data.invoice.currency}`;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;

    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(22).text(data.organization.name, left, 50);
    doc.font('Helvetica').fontSize(10).fillColor('#475569');
    let y = 80;
    for (const line of data.organization.addressLines) {
      doc.text(line, left, y);
      y = doc.y;
    }
    if (data.organization.taxIdentifier) {
      doc.text(`Tax ID: ${data.organization.taxIdentifier}`);
    }

    doc.font('Helvetica-Bold').fontSize(26).fillColor('#0f172a').text('INVOICE', left, 50, {
      width: pageWidth,
      align: 'right',
    });
    doc.font('Helvetica').fontSize(11).fillColor('#334155').text(data.invoice.invoiceNumber, left, 82, {
      width: pageWidth,
      align: 'right',
    });

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('Bill to', left, 140);
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    let customerY = 155;
    doc.text(data.customer.name, left, customerY);
    customerY = doc.y;
    for (const line of data.customer.addressLines) {
      doc.text(line, left, customerY);
      customerY = doc.y;
    }
    if (data.customer.taxIdentifier) doc.text(`Tax ID: ${data.customer.taxIdentifier}`);

    doc.font('Helvetica-Bold').fillColor('#0f172a').text('Issue date', left, 140, { width: pageWidth / 2, align: 'right' });
    doc.font('Helvetica').fillColor('#334155').text(data.invoice.issueDate, left, 155, {
      width: pageWidth / 2,
      align: 'right',
    });
    doc.font('Helvetica-Bold').fillColor('#0f172a').text('Due date', left, 172, { width: pageWidth / 2, align: 'right' });
    doc.font('Helvetica').fillColor('#334155').text(data.invoice.dueDate ?? 'On receipt', left, 187, {
      width: pageWidth / 2,
      align: 'right',
    });

    // Line item table
    let tableY = 230;
    doc.rect(left, tableY, pageWidth, 22).fill('#f1f5f9');
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9);
    doc.text('Description', left + 8, tableY + 7);
    doc.text('Qty', left + 300, tableY + 7, { width: 40, align: 'right' });
    doc.text('Unit price', left + 348, tableY + 7, { width: 80, align: 'right' });
    doc.text('Amount', left + 436, tableY + 7, { width: 60, align: 'right' });
    tableY += 22;

    doc.font('Helvetica').fontSize(9).fillColor('#1e293b');
    for (const item of data.items) {
      if (tableY > doc.page.height - 160) {
        doc.addPage();
        tableY = 50;
      }
      const rowHeight = Math.max(18, doc.heightOfString(item.description, { width: 280 }) + 8);
      doc.text(item.description, left + 8, tableY + 5, { width: 280 });
      doc.text(item.quantity, left + 300, tableY + 5, { width: 40, align: 'right' });
      doc.text(formatMinorAsDecimal(item.unitPriceMinor, data.invoice.currency), left + 348, tableY + 5, {
        width: 80,
        align: 'right',
      });
      doc.text(formatMinorAsDecimal(item.lineTotalMinor, data.invoice.currency), left + 436, tableY + 5, {
        width: 60,
        align: 'right',
      });
      doc.moveTo(left, tableY + rowHeight).lineTo(left + pageWidth, tableY + rowHeight).strokeColor('#e2e8f0').stroke();
      tableY += rowHeight;
    }

    tableY += 12;
    const totalsRow = (label: string, value: number, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(bold ? '#0f172a' : '#334155');
      doc.text(label, left + 330, tableY, { width: 120, align: 'right' });
      doc.text(money(value), left + 450, tableY, { width: 46, align: 'right' });
      tableY += 16;
    };
    totalsRow('Subtotal', data.invoice.subtotalMinor);
    if (data.invoice.discountMinor > 0) totalsRow('Discount', -data.invoice.discountMinor);
    if (data.invoice.taxMinor > 0) totalsRow(data.invoice.taxLabel, data.invoice.taxMinor);
    totalsRow('Total', data.invoice.totalMinor, true);
    if (data.invoice.paidMinor > 0) totalsRow('Paid', -data.invoice.paidMinor);
    totalsRow('Balance due', data.invoice.balanceMinor, true);

    tableY += 12;
    const block = (heading: string, body: string | null) => {
      if (!body) return;
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text(heading, left, tableY);
      tableY = doc.y + 2;
      doc.font('Helvetica').fontSize(9).fillColor('#334155').text(body, left, tableY, { width: pageWidth });
      tableY = doc.y + 10;
    };
    block('Notes', data.invoice.notes);
    block('Terms', data.invoice.terms);
    block('Payment instructions', data.invoice.paymentInstructions);

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#94a3b8')
      .text(
        'Generated by CollectFlow. CollectFlow is an invoicing and payment-tracking tool and is not a bank, payment processor or tax adviser. Tax figures are recorded as entered by the issuer.',
        left,
        doc.page.height - 70,
        { width: pageWidth },
      );

    doc.end();
  });
}

function toDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}