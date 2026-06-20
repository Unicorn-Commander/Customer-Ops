/**
 * Typed data layer for the command-center OVERVIEW surfaces — the top-level
 * "see the whole workspace at a glance" pages (Invoices · Email · Outreach).
 *
 * Mirrors `lib/customers.ts`: the workspace id is resolved from the caller's
 * default membership and threaded into every path as
 * `/workspaces/:workspaceId/overview/*`. Customer-Ops never mints a workspace id.
 *
 * Every endpoint is a GET that returns `{ items, summary }` and degrades clean
 * (empty arrays, zeroed summary) when an upstream app is dormant — so the pages
 * render their calm empty state rather than an error. Each row carries the
 * `customerId` it belongs to so a row can deep-link to that customer's 360.
 *
 * Money is always a decimal STRING (never a float) — format it for display with
 * `money()` from `lib/customers`, which keeps the string as a fallback.
 */

import { apiGet } from './api';

/* ── Invoices ─────────────────────────────────────────────────────────────── */

/** One row of the workspace invoices overview — the latest invoice link per
 *  customer, joined with Accounting-Ops's live (polled) status. */
export interface InvoiceOverviewItem {
  customerId: string;
  contactName: string | null;
  contactOrg: string | null;
  invoiceNumber: string | null;
  lastStatus: string | null; // draft|sent|partial|paid|void (AO)
  currency: string;
  totalAmount: string | null;
  lastBalanceDue: string | null;
  lastPolledAt: string | null;
  createdAt: string;
}

export interface InvoiceOverviewSummary {
  count: number;
  byStatus: Record<string, number>;
  totalOutstanding: string;
  currency: string;
}

export interface InvoiceOverview {
  items: InvoiceOverviewItem[];
  summary: InvoiceOverviewSummary;
}

/* ── Outreach ─────────────────────────────────────────────────────────────── */

/** One row of the workspace outreach overview — the latest touch per customer,
 *  joined with the Outreach app's view. */
export interface OutreachOverviewItem {
  customerId: string;
  contactName: string | null;
  channel: 'email' | 'social';
  campaignName: string | null;
  lastStatus: string | null;
  lastPolledAt: string | null;
  createdAt: string;
}

export interface OutreachOverviewSummary {
  count: number;
  byStatus: Record<string, number>;
}

export interface OutreachOverview {
  items: OutreachOverviewItem[];
  summary: OutreachOverviewSummary;
}

/* ── Email ────────────────────────────────────────────────────────────────── */

/** One row of the workspace email overview — an outbound send/draft, joined with
 *  the Email-Ops app's view. */
export interface EmailOverviewItem {
  customerId: string;
  contactName: string | null;
  type: 'send' | 'draft';
  lastStatus: string | null;
  externalRef: string;
  createdAt: string;
}

export interface EmailOverviewSummary {
  count: number;
  byType: { send: number; draft: number };
}

export interface EmailOverview {
  items: EmailOverviewItem[];
  summary: EmailOverviewSummary;
}

/* ── client ───────────────────────────────────────────────────────────────── */

function base(ws: string): string {
  return `/workspaces/${encodeURIComponent(ws)}/overview`;
}

/** Every invoice across the workspace, with live status from Accounting-Ops. */
export async function getInvoicesOverview(ws: string): Promise<InvoiceOverview> {
  return apiGet<InvoiceOverview>(`${base(ws)}/invoices`);
}

/** Every outreach touch across the workspace, from the Outreach app. */
export async function getOutreachOverview(ws: string): Promise<OutreachOverview> {
  return apiGet<OutreachOverview>(`${base(ws)}/outreach`);
}

/** Every send/draft across the workspace, from Email-Ops. */
export async function getEmailOverview(ws: string): Promise<EmailOverview> {
  return apiGet<EmailOverview>(`${base(ws)}/email`);
}
