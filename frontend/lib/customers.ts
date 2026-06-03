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
  invoices: { federated: boolean; source: string; items: unknown[] };
  meetings: { federated: boolean; source: string; items: unknown[] };
  email: { federated: boolean; source: string; items: unknown[] };
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
