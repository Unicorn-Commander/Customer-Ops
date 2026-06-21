/**
 * Typed data layer for the signed-in user's profile (Settings → Profile).
 *
 * Identity is SSO-managed — Customer-Ops never owns the name/email; it reads the
 * local projection the backend mints from the suite session. So this is a pure
 * read surface (no PATCH): the view shows who you are + which workspaces you
 * belong to, and points changes at suite SSO.
 *
 * Two reads back the page:
 *   • GET /auth/profile        → the identity card (camelCase)
 *   • GET /auth/me/workspaces  → the workspace membership list (snake_case)
 */

import { apiGet, type MyWorkspace } from './api';

/** The signed-in user's identity, as the backend projects it from SSO. */
export interface Profile {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Fetch the signed-in user's profile (SSO-managed identity projection). */
export async function getProfile(): Promise<Profile> {
  return apiGet<Profile>('/auth/profile');
}

/** Fetch the workspaces the signed-in user belongs to (membership-derived). */
export async function getMyWorkspaces(): Promise<MyWorkspace[]> {
  const res = await apiGet<{ workspaces: MyWorkspace[] }>('/auth/me/workspaces');
  return res.workspaces ?? [];
}

/** The display name (first + last), falling back to the username when unset. */
export function profileName(p: Profile): string {
  return `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.username;
}
