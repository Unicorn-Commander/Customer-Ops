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
  meetings: { federated: boolean; source: string; items: unknown[] };
  email: { federated: boolean; source: string; items: unknown[] };
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
