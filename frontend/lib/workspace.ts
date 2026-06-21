/**
 * Typed data layer for the active workspace (Settings → Workspace).
 *
 * The workspace id is resolved by `useWorkspace()` (membership-derived; the UI
 * never mints one). This layer reads the workspace's identity + member roster
 * and — for an OWNER only — exposes the two member-management mutations.
 *
 * The backend is the source of truth for who may manage: it returns `can_manage`
 * on the roster and enforces the owner-only rule + the last-owner guard, so the
 * UI shows controls optimistically but always defers to the server (a 403/400
 * surfaces inline and the optimistic change rolls back).
 *
 * Reads are snake_case (the workspace surface), except the workspace identity
 * fields the backend already camelCases (isolation_mode etc. stay snake_case;
 * see the shapes below). Roles/statuses are lowercase on read; the role PATCH
 * sends them UPPERCASE.
 */

import { apiGet, apiPatch, apiDelete } from './api';

/** The five suite roles, most → least privileged. Sent UPPERCASE on write. */
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' | 'VIEWER';

export const WORKSPACE_ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'];

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

/** The workspace identity card. `your_role` is lowercase, or null if unknown. */
export interface WorkspaceDetail {
  workspace_id: string;
  slug: string;
  display_name: string;
  status: string;
  isolation_mode: string;
  isolation_tier: string;
  hipaa_mode: boolean;
  gdpr_mode: boolean;
  data_residency: string | null;
  created_at: string;
  your_role: string | null;
  member_count: number;
}

/** One member row. role/status are lowercase; timestamps may be null. */
export interface WorkspaceMember {
  user_key: string;
  email: string | null;
  display_name: string | null;
  username: string | null;
  role: string;
  status: string;
  is_default: boolean;
  is_service: boolean;
  is_you: boolean;
  last_login_at: string | null;
  joined_at: string | null;
}

/** The roster response: members + the caller's role + the manage capability. */
export interface WorkspaceMembers {
  members: WorkspaceMember[];
  your_role: string | null;
  /** True iff the caller is OWNER (the backend's authority on management). */
  can_manage: boolean;
}

function base(ws: string): string {
  return `/workspaces/${encodeURIComponent(ws)}`;
}

/** Fetch the active workspace's identity + posture. */
export async function getWorkspace(ws: string): Promise<WorkspaceDetail> {
  return apiGet<WorkspaceDetail>(base(ws));
}

/** Fetch the active workspace's member roster + the caller's manage capability. */
export async function getWorkspaceMembers(ws: string): Promise<WorkspaceMembers> {
  return apiGet<WorkspaceMembers>(`${base(ws)}/members`);
}

/** Change a member's role (OWNER-only; sends the role UPPERCASE). */
export async function updateMemberRole(
  ws: string,
  userKey: string,
  role: WorkspaceRole,
): Promise<WorkspaceMember> {
  return apiPatch<WorkspaceMember>(
    `${base(ws)}/members/${encodeURIComponent(userKey)}`,
    { role },
  );
}

/** Remove a member from the workspace (OWNER-only; 204 on success). */
export async function removeMember(ws: string, userKey: string): Promise<void> {
  await apiDelete(`${base(ws)}/members/${encodeURIComponent(userKey)}`);
}

/** A human label for a member's display name, with a safe fallback. */
export function memberName(m: WorkspaceMember): string {
  return m.display_name || m.username || m.email || '(unknown)';
}

/** Short initials for an avatar tile — name parts, else a neutral fallback. */
export function memberInitials(m: WorkspaceMember): string {
  const name = memberName(m);
  const parts = name.replace(/[()]/g, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || name === '(unknown)') return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
