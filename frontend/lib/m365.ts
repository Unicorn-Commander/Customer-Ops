/**
 * Typed data layer for the Microsoft 365 connector.
 *
 * A signed-in user links their OWN Microsoft 365 account (OAuth) and pulls their
 * Outlook contacts INTO Customer-Ops, where each is funneled through the existing
 * lead-intake pipeline. These four wrappers mirror the backend's `m365/*` REST
 * surface 1:1. The connector is DORMANT unless the deployment configures
 * M365_CLIENT_ID — `getStatus` reports `{configured:false}` in that case so the UI
 * can render the disabled "not configured on this deployment" state honestly.
 *
 * Unlike the lead-intake wrappers these paths are NOT workspace-scoped: a
 * connection is account-linking, so the backend resolves the caller's active
 * workspace from the session.
 */

import { apiGet, apiPost, apiDelete } from './api';

/** The SAFE connection metadata the status route returns (never a token). */
export interface M365ConnectionView {
  id: string;
  m365UserId: string;
  m365UserPrincipal: string | null;
  scopes: string[];
  status: 'ACTIVE' | 'REVOKED' | 'ERROR';
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  hasDeltaLink: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The connector status for the current user. */
export interface M365Status {
  /** Whether the deployment configured the connector at all (M365_CLIENT_ID set). */
  configured: boolean;
  /** Whether THIS user has an active link in their active workspace. */
  connected: boolean;
  connection: M365ConnectionView | null;
}

/** The outcome of a contact sync run. */
export interface M365SyncResult {
  ok: boolean;
  status: string;
  contactsSeen: number;
  ingested: number;
  failed: number;
  detail: string;
  lastSyncAt: string | null;
}

/** Read the connector status (configured + connected + connection metadata). */
export function getM365Status(): Promise<M365Status> {
  return apiGet<M365Status>('/m365/status');
}

/** Begin the connect flow — returns the Microsoft consent URL the SPA navigates to. */
export function startM365Connect(): Promise<{ url: string }> {
  return apiGet<{ url: string }>('/m365/oauth/start');
}

/** Pull the user's Microsoft 365 contacts into the lead pipeline. */
export function syncM365Contacts(): Promise<M365SyncResult> {
  return apiPost<M365SyncResult>('/m365/sync');
}

/** Disconnect — delete the stored credential (idempotent). */
export function disconnectM365(): Promise<{ disconnected: boolean }> {
  return apiDelete<{ disconnected: boolean }>('/m365/connection');
}
