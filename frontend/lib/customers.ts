/**
 * Typed data layer for the Customer-Ops relationship cockpit (Phase 2).
 *
 * Mirrors the backend's workspace-scoped REST surface
 * (`/workspaces/:workspaceId/customers`). The workspace id is resolved from the
 * caller's default membership (`GET /auth/me/workspaces`) — Customer-Ops never
 * mints workspace ids; the UI uses the one the backend says the user belongs to.
 *
 * Contacts on every row are FEDERATED from Contact-Ops by the backend and may be
 * null (CO dormant/unknown) — the UI renders a placeholder, never a copy.
 */

import { apiGet, apiPatch, apiPost, MyWorkspace } from './api';

export type Stage = 'LEAD' | 'PROSPECT' | 'CUSTOMER';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH';

export const STAGES: Stage[] = ['LEAD', 'PROSPECT', 'CUSTOMER'];
export const STAGE_LABEL: Record<Stage, string> = {
  LEAD: 'Leads',
  PROSPECT: 'Prospects',
  CUSTOMER: 'Customers',
};

/** A relationship row joined with its (optional) federated contact summary. */
export interface CustomerRow {
  id: string;
  contactId: string;
  stage: Stage;
  priority: Priority;
  source: string | null;
  notes: string | null;
  ownerUserKey: string | null;
  expectedValue: string | null;
  currency: string | null;
  nextActionAt: string | null;
  isLost: boolean;
  lostReason: string | null;
  closedLostAt: string | null;
  lastStageChangeAt: string;
  createdAt: string;
  updatedAt: string;
  contact: {
    displayName: string;
    primaryEmail: string | null;
    currentOrgName: string | null;
    tags: string[];
  } | null;
}

export interface PipelineLane {
  stage: Stage;
  count: number;
  expectedValue: string;
  cards: CustomerRow[];
}

export interface PipelineBoard {
  lanes: PipelineLane[];
  totals: { count: number; expectedValue: string };
}

export interface TimelineEntry {
  id: string;
  kind: string;
  fromStage: Stage | null;
  toStage: Stage | null;
  body: string | null;
  actorUcUid: string | null;
  createdAt: string;
}

/**
 * A thin invoice link joined with Accounting-Ops's live (polled) status. AO is
 * the AR engine / ledger system-of-record; Customer-Ops holds only the link +
 * cached projection. Money fields are decimal STRINGS (never float).
 */
export interface InvoiceLink {
  id: string;
  customerId: string;
  externalSource: string;
  externalRef: string;
  entityId: string;
  aoInvoiceId: string | null;
  invoiceNumber: string | null;
  status: string | null; // draft|sent|partial|paid|void (AO)
  currency: string;
  total: string | null;
  balanceDue: string | null;
  lastPolledAt: string | null;
  createdAt: string;
}

/**
 * The customer-360 invoice panel: the federated AO invoice list + the
 * degrade-clean / entitlement affordances.
 *   - `configured` false  → AO not connected; show "connect Accounting-Ops".
 *   - `entitled` false     → caller lacks the customer-ops+accounting-ops SKUs;
 *                            history is read-only, the create action is hidden.
 *   - `canCreate`          → configured && entitled.
 */
export interface InvoicePanel {
  federated: boolean;
  source: string; // 'accounting-ops'
  configured: boolean;
  entitled: boolean;
  canCreate: boolean;
  items: InvoiceLink[];
}

/**
 * A thin outreach enrollment link joined with the Outreach app's view. The
 * Outreach app (Listmonk + Postiz) is the campaign system-of-record;
 * Customer-Ops holds only the link + cached status.
 */
export interface OutreachEnrollment {
  id: string;
  contactId: string;
  channel: string; // 'email' | 'social'
  externalSource: string;
  externalRef: string;
  campaignId: string | null;
  outreachId: string | null;
  campaignName: string | null;
  status: string | null;
  lastPolledAt: string | null;
  createdAt: string;
}

/** A federated Outreach campaign (the "start a campaign" picker). */
export interface OutreachCampaign {
  id: string;
  name: string;
  channel: string;
  status: string;
  isSequence: boolean;
  createdAt: string | null;
}

/** A federated Outreach touch (the contact's outreach history). */
export interface OutreachTouch {
  id: string;
  channel: string;
  campaignId: string | null;
  campaignName: string | null;
  status: string;
  subject: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  lastEngagementKind: string | null;
  lastEngagementAt: string | null;
}

/**
 * The customer-360 outreach panel: the federated campaigns/touches + the local
 * enrollment links + the degrade-clean / entitlement affordances.
 *   - `configured` false  → Outreach not connected; show "connect Outreach".
 *   - `entitled` false     → caller lacks customer-ops+outreach; reads only.
 *   - `canStart`           → configured && entitled.
 */
export interface OutreachPanel {
  federated: boolean;
  source: string; // 'outreach'
  configured: boolean;
  entitled: boolean;
  canStart: boolean;
  campaigns: OutreachCampaign[];
  touches: OutreachTouch[];
  enrollments: OutreachEnrollment[];
}

/** A federated Email-Ops mailbox thread with the contact (history). */
export interface EmailThread {
  id: string;
  subject: string | null;
  messageCount: number;
  unread: boolean;
  lastMessageAt: string | null;
  lastSnippet: string | null;
  participants: Array<{ address: string; name: string | null }>;
}

/** A thin outbound-email link joined with the Email-Ops app's view. */
export interface EmailLink {
  id: string;
  contactId: string;
  mode: string; // 'send' | 'draft'
  externalSource: string;
  externalRef: string;
  threadId: string | null;
  messageId: string | null;
  subject: string | null;
  status: string | null;
  lastPolledAt: string | null;
  createdAt: string;
}

/**
 * The customer-360 email panel: the federated mailbox threads + the local
 * outbound links + the degrade-clean / entitlement affordances.
 *   - `configured` false  → Email-Ops not connected; show "connect Email-Ops".
 *   - `entitled` false     → caller lacks customer-ops+email-ops; reads only.
 *   - `canSend`            → configured && entitled.
 */
export interface EmailPanel {
  federated: boolean;
  source: string; // 'email-ops'
  configured: boolean;
  entitled: boolean;
  canSend: boolean;
  threads: EmailThread[];
  sent: EmailLink[];
}

export interface Customer360 {
  relationship: CustomerRow;
  contact: {
    contactId: string;
    displayName: string;
    primaryEmail: string | null;
    currentOrgName: string | null;
    tags: string[];
    kind: string;
    status: string;
    emails: Array<{ address: string; type?: string; is_primary?: boolean }>;
    phones: Array<{ e164: string; type?: string; is_primary?: boolean }>;
  } | null;
  contactFederation: { contactId: string; resolved: boolean; source: string };
  timeline: TimelineEntry[];
  invoices: InvoicePanel;
  outreach: OutreachPanel;
  email: EmailPanel;
  meetings: { federated: boolean; source: string; items: unknown[] };
}

/** One invoice line for the create-invoice action. Money = decimal strings. */
export interface InvoiceLineInput {
  description: string;
  quantity?: string;
  unitPrice?: string;
  amount?: string;
  taxCode?: string;
  taxAmount?: string;
  revenueAccountId?: string;
  sourceRef?: string;
}

/** The create-invoice request body (mirrors the backend CreateInvoiceDto). */
export interface CreateInvoiceInput {
  entityId: string;
  customerName: string;
  customerEmail?: string;
  billingAddress?: string;
  lineItems: InvoiceLineInput[];
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  netTerms?: number;
  discount?: string;
  notes?: string;
  poNumber?: string;
  autoSend?: boolean;
  idempotencyKey?: string;
}

/** Resolve the caller's active workspace id (default membership, else first). */
export async function resolveWorkspaceId(): Promise<string | null> {
  const res = await apiGet<{ workspaces: MyWorkspace[] }>('/auth/me/workspaces');
  if (!res.workspaces || res.workspaces.length === 0) return null;
  const def = res.workspaces.find((w) => w.is_default) ?? res.workspaces[0];
  return def.workspace_id;
}

function base(ws: string): string {
  return `/workspaces/${encodeURIComponent(ws)}/customers`;
}

export async function listCustomers(
  ws: string,
  opts: { stage?: Stage; includeLost?: boolean } = {},
): Promise<CustomerRow[]> {
  const params = new URLSearchParams();
  if (opts.stage) params.set('stage', opts.stage);
  if (opts.includeLost) params.set('includeLost', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await apiGet<{ items: CustomerRow[] }>(`${base(ws)}${qs}`);
  return res.items;
}

export async function getPipeline(ws: string): Promise<PipelineBoard> {
  return apiGet<PipelineBoard>(`${base(ws)}/pipeline`);
}

export async function getCustomer360(ws: string, id: string): Promise<Customer360> {
  return apiGet<Customer360>(`${base(ws)}/${encodeURIComponent(id)}/360`);
}

export async function createCustomer(
  ws: string,
  body: { contactId: string; stage?: Stage; priority?: Priority; source?: string; expectedValue?: string },
): Promise<CustomerRow> {
  return apiPost<CustomerRow>(base(ws), body);
}

export async function transitionStage(
  ws: string,
  id: string,
  toStage: Stage,
  note?: string,
): Promise<CustomerRow> {
  return apiPost<CustomerRow>(`${base(ws)}/${encodeURIComponent(id)}/transition`, { toStage, note });
}

export async function markLost(ws: string, id: string, reason: string): Promise<CustomerRow> {
  return apiPost<CustomerRow>(`${base(ws)}/${encodeURIComponent(id)}/lost`, { reason });
}

export async function reopen(ws: string, id: string): Promise<CustomerRow> {
  return apiPost<CustomerRow>(`${base(ws)}/${encodeURIComponent(id)}/reopen`, {});
}

export async function addNote(ws: string, id: string, body: string): Promise<unknown> {
  return apiPost(`${base(ws)}/${encodeURIComponent(id)}/notes`, { body });
}

export async function updateCustomer(
  ws: string,
  id: string,
  body: Partial<{ priority: Priority; ownerUserKey: string; expectedValue: string; notes: string; nextActionAt: string }>,
): Promise<CustomerRow> {
  return apiPatch<CustomerRow>(`${base(ws)}/${encodeURIComponent(id)}`, body);
}

// ── Phase 3: the Accounting-Ops invoicing surface ──
// Customer-Ops FEDERATES invoicing to Accounting-Ops; the backend creates the
// invoice in AO (the ledger SoR) and keeps only a thin link. The UI renders
// the federated list + live status and offers the create action when entitled.

/** This customer's invoices, federated from Accounting-Ops (live status). */
export async function listInvoices(ws: string, id: string): Promise<InvoicePanel> {
  return apiGet<InvoicePanel>(`${base(ws)}/${encodeURIComponent(id)}/invoices`);
}

/** Assemble a draft + create the invoice in Accounting-Ops (idempotent). */
export async function createInvoice(
  ws: string,
  id: string,
  body: CreateInvoiceInput,
): Promise<{ link: InvoiceLink; invoice: unknown }> {
  return apiPost<{ link: InvoiceLink; invoice: unknown }>(
    `${base(ws)}/${encodeURIComponent(id)}/invoices`,
    body,
  );
}

// ── Phase 4: the Outreach surface (the Outreach app: Listmonk + Postiz) ──
// Customer-Ops FEDERATES outreach; the backend enrolls the contact in the
// Outreach app (the campaign SoR) and keeps only a thin link. The UI renders the
// federated campaigns/touches + offers a start-campaign action when entitled.

/** Start a campaign for this customer's contact (mirrors StartCampaignDto). */
export interface StartCampaignInput {
  campaignId: string;
  contactEmail?: string;
  mergeFields?: Record<string, string>;
  idempotencyKey?: string;
}

/** This customer's outreach, federated from the Outreach app. */
export async function listOutreach(ws: string, id: string): Promise<OutreachPanel> {
  return apiGet<OutreachPanel>(`${base(ws)}/${encodeURIComponent(id)}/outreach`);
}

/** Enroll this customer's contact into an Outreach campaign (idempotent). */
export async function startCampaign(
  ws: string,
  id: string,
  body: StartCampaignInput,
): Promise<{ link: OutreachEnrollment; enrollment: unknown }> {
  return apiPost<{ link: OutreachEnrollment; enrollment: unknown }>(
    `${base(ws)}/${encodeURIComponent(id)}/outreach/campaigns`,
    body,
  );
}

// ── Phase 4: the Email surface (the Email-Ops app: Stalwart) ──
// Customer-Ops FEDERATES mailboxes; the backend sends/drafts via the Email-Ops
// app (the mailbox SoR) and keeps only a thin link. The UI renders the federated
// threads + offers a send/draft action when entitled.

/** Send or draft an outbound email (mirrors SendEmailDto). */
export interface SendEmailInput {
  toAddress?: string;
  subject: string;
  body: string;
  inReplyToThreadId?: string;
  mode?: 'send' | 'draft';
  idempotencyKey?: string;
}

/** This customer's email, federated from the Email-Ops app. */
export async function listEmail(ws: string, id: string): Promise<EmailPanel> {
  return apiGet<EmailPanel>(`${base(ws)}/${encodeURIComponent(id)}/email`);
}

/** Send or draft an outbound email to this customer's contact (idempotent). */
export async function sendEmail(
  ws: string,
  id: string,
  body: SendEmailInput,
): Promise<{ link: EmailLink; message: unknown }> {
  return apiPost<{ link: EmailLink; message: unknown }>(
    `${base(ws)}/${encodeURIComponent(id)}/email`,
    body,
  );
}

/** A human label + tone for an outreach touch / enrollment status. */
export function outreachStatusLabel(status: string | null): { label: string; tone: string } {
  switch (status) {
    case 'replied':
      return { label: 'Replied', tone: 'ok' };
    case 'clicked':
      return { label: 'Clicked', tone: 'ok' };
    case 'opened':
      return { label: 'Opened', tone: 'info' };
    case 'delivered':
    case 'sent':
      return { label: 'Sent', tone: 'info' };
    case 'scheduled':
      return { label: 'Scheduled', tone: 'info' };
    case 'queued':
      return { label: 'Queued', tone: 'muted' };
    case 'bounced':
    case 'failed':
      return { label: status === 'bounced' ? 'Bounced' : 'Failed', tone: 'warn' };
    case null:
      return { label: 'Pending', tone: 'muted' };
    default:
      return { label: status, tone: 'info' };
  }
}

/** A human label + tone for an Email-Ops message status. */
export function emailStatusLabel(status: string | null): { label: string; tone: string } {
  switch (status) {
    case 'delivered':
      return { label: 'Delivered', tone: 'ok' };
    case 'sent':
      return { label: 'Sent', tone: 'info' };
    case 'queued':
      return { label: 'Queued', tone: 'muted' };
    case 'pending_approval':
      return { label: 'Awaiting approval', tone: 'warn' };
    case 'draft':
      return { label: 'Draft', tone: 'muted' };
    case 'failed':
      return { label: 'Failed', tone: 'warn' };
    case null:
      return { label: 'Pending', tone: 'muted' };
    default:
      return { label: status, tone: 'info' };
  }
}

/** A human label + tone for an AO invoice status. */
export function invoiceStatusLabel(status: string | null): { label: string; tone: string } {
  switch (status) {
    case 'paid':
      return { label: 'Paid', tone: 'ok' };
    case 'partial':
      return { label: 'Partially paid', tone: 'warn' };
    case 'sent':
      return { label: 'Sent', tone: 'info' };
    case 'void':
      return { label: 'Void', tone: 'muted' };
    case 'draft':
      return { label: 'Draft', tone: 'muted' };
    case null:
      return { label: 'Pending', tone: 'muted' };
    default:
      return { label: status, tone: 'info' };
  }
}

/** A short, human label for a relationship — federated name, else the contactId. */
export function contactLabel(row: CustomerRow | Customer360['relationship']): string {
  const c = (row as CustomerRow).contact;
  if (c?.displayName) return c.displayName;
  return `contact ${row.contactId.slice(0, 8)}…`;
}

/** Format a decimal money string for display ("1500.0000" -> "$1,500"). */
export function money(value: string | null, currency = 'USD'): string {
  if (value === null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `$${Math.round(n).toLocaleString()}`;
  }
}
