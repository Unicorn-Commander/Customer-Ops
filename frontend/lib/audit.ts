/**
 * Typed data layer for the AUDIT TRAIL surface — the append-only, newest-first
 * record of every action taken across a workspace.
 *
 * Mirrors `lib/overview.ts`: the workspace id is resolved from the caller's
 * default membership and threaded into every path as
 * `/workspaces/:workspaceId/audit/*`. Customer-Ops never mints a workspace id.
 *
 * The trail is read-only by construction — it is written by the backend as a
 * side effect of every mutating action and is never edited from the client.
 */

import { apiGet } from './api';

/** The recorded action verb. The backend writes one of these per log row. */
export type AuditAction =
  | 'CREATE'
  | 'READ'
  | 'UPDATE'
  | 'DELETE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'EXPORT'
  | 'IMPORT'
  | 'EXECUTE';

/** One immutable audit-log entry, newest-first as returned by the backend. */
export interface AuditLogRow {
  id: string;
  workspaceId: string;
  userId: string | null;
  action: AuditAction;
  resource: string;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: string;
}

/** A page of audit-log rows plus the total count for the (filtered) query. */
export interface AuditPage {
  logs: AuditLogRow[];
  total: number;
}

/* ── client ───────────────────────────────────────────────────────────────── */

function base(ws: string): string {
  return `/workspaces/${encodeURIComponent(ws)}/audit`;
}

/** A page of the workspace audit trail, optionally filtered by action/resource.
 *  `apiGet` takes only a path, so the query string is built here. */
export async function getAuditTrail(
  ws: string,
  { skip, take, action, resource }: { skip?: number; take?: number; action?: AuditAction; resource?: string } = {},
): Promise<AuditPage> {
  const qs = new URLSearchParams();
  if (skip !== undefined) qs.set('skip', String(skip));
  if (take !== undefined) qs.set('take', String(take));
  if (action) qs.set('action', action);
  if (resource) qs.set('resource', resource);
  const query = qs.toString();
  return apiGet<AuditPage>(`${base(ws)}${query ? `?${query}` : ''}`);
}

/** Every audit entry for a single resource instance, newest-first. */
export async function getResourceAuditTrail(
  ws: string,
  resource: string,
  resourceId: string,
): Promise<AuditLogRow[]> {
  return apiGet<AuditLogRow[]>(
    `${base(ws)}/resource/${encodeURIComponent(resource)}/${encodeURIComponent(resourceId)}`,
  );
}
