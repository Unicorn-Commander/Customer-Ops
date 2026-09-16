'use client';

/* =============================================================================
   Settings → Workspace — identity, members, and OWNER-only management
   -----------------------------------------------------------------------------
   The active workspace's identity + posture, its member roster, and — for an
   OWNER only — the two management actions (change a member's role, remove a
   member). The backend is the authority: it returns `can_manage` (true iff the
   caller is OWNER) and enforces the last-owner guard, so the UI shows controls
   optimistically but always defers to the server — a 400/403 surfaces inline and
   the optimistic role change rolls back.

   Owners can create manual invitations and isolated additional workspaces.
   ========================================================================== */

import { OnboardingPanel } from './onboarding-panel';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Building2, ArrowLeft, AlertCircle, RefreshCw, Trash2,
  Loader2, ShieldAlert, Bot,
} from 'lucide-react';
import { Badge, Button, cn } from '@/components/ui';
import { IconTile } from '@/components/ui/IconTile';
import { useWorkspace } from '@/lib/useWorkspace';
import { useOverlay } from '@/lib/useOverlay';
import { ApiError } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import {
  getWorkspace, getWorkspaceMembers, updateMemberRole, removeMember,
  memberName, memberInitials, WORKSPACE_ROLES, ROLE_LABEL,
  type WorkspaceDetail, type WorkspaceMembers, type WorkspaceMember, type WorkspaceRole,
} from '@/lib/workspace';

/** Pull a human message off an ApiError (it folds the server detail into
 *  `.message`), falling back to a friendly default. */
function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/* ── a labelled identity field ────────────────────────────────────────────────── */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-tertiary">{label}</dt>
      <dd className="mt-1 truncate text-sm text-primary">{value}</dd>
    </div>
  );
}

/* ── loading skeleton ─────────────────────────────────────────────────────────── */
function WorkspaceSkeleton() {
  return (
    <>
      <div className="rounded-token-lg border border-subtle bg-surface-raised p-5">
        <div className="flex items-center gap-4">
          <div className="h-11 w-11 animate-pulse rounded-[13px] bg-surface-overlay" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-44 animate-pulse rounded bg-surface-overlay" />
            <div className="h-3 w-32 animate-pulse rounded bg-surface-overlay" />
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-2.5 w-16 animate-pulse rounded bg-surface-overlay" />
              <div className="h-3.5 w-24 animate-pulse rounded bg-surface-overlay" />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-token-lg border border-subtle bg-surface-raised p-5">
        <div className="h-3 w-28 animate-pulse rounded bg-surface-overlay" />
        <div className="mt-4 space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-14 w-full animate-pulse rounded bg-surface-overlay" />)}
        </div>
      </div>
    </>
  );
}

/* ── a single roster row ──────────────────────────────────────────────────────── */
function MemberRow({
  member,
  canManage,
  busy,
  onRoleChange,
  onRemove,
}: {
  member: WorkspaceMember;
  canManage: boolean;
  busy: boolean;
  onRoleChange: (m: WorkspaceMember, role: WorkspaceRole) => void;
  onRemove: (m: WorkspaceMember) => void;
}) {
  const name = memberName(member);
  // The owner gets controls on every non-service member. Service identities are
  // backend principals (not people) — never offer to re-role or remove them.
  const manageable = canManage && !member.is_service;

  return (
    <li className="flex flex-col gap-3 rounded-token border border-subtle bg-surface-overlay/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      {/* Identity */}
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-[11px] font-bold text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_3px_8px_-2px_rgba(0,0,0,0.45)]">
          {member.is_service ? <Bot className="h-4 w-4" strokeWidth={2.4} aria-hidden /> : memberInitials(member)}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-primary">{name}</span>
            {member.is_you && (
              <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">You</span>
            )}
            {member.is_service && (
              <span className="rounded-full bg-surface-overlay px-1.5 py-0.5 text-[10px] font-medium text-tertiary">Service</span>
            )}
            {member.status !== 'active' && (
              <Badge variant="warning" className="px-1.5 py-0 text-[10px] capitalize">{member.status}</Badge>
            )}
          </div>
          {member.email && <p className="mt-0.5 truncate text-xs text-tertiary">{member.email}</p>}
        </div>
      </div>

      {/* Role + last-seen + actions */}
      <div className="flex shrink-0 items-center gap-3 sm:justify-end">
        <span className="hidden text-xs text-tertiary sm:inline">
          Last seen {relativeTime(member.last_login_at)}
        </span>
        {manageable ? (
          <>
            <label className="sr-only" htmlFor={`role-${member.user_key}`}>
              Role for {name}
            </label>
            <select
              id={`role-${member.user_key}`}
              value={(member.role || '').toUpperCase()}
              disabled={busy}
              onChange={(e) => onRoleChange(member, e.target.value as WorkspaceRole)}
              className="rounded-token border border-subtle bg-surface-overlay/70 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
            >
              {WORKSPACE_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${name}`}
              disabled={busy}
              onClick={() => onRemove(member)}
              leading={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" strokeWidth={2.25} />}
            >
              Remove
            </Button>
          </>
        ) : (
          <Badge variant="neutral" className="capitalize">{ROLE_LABEL[(member.role || '').toUpperCase() as WorkspaceRole] ?? member.role}</Badge>
        )}
      </div>
    </li>
  );
}

/* ── the page ───────────────────────────────────────────────────────────────── */
export default function WorkspacePage() {
  const { workspaceId, loading: wsLoading, error: wsError } = useWorkspace();
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [roster, setRoster] = useState<WorkspaceMembers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Inline action feedback + per-row busy guard (keyed by user_key).
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<WorkspaceMember | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    setRefreshing(true);
    try {
      const [d, m] = await Promise.all([
        getWorkspace(workspaceId),
        getWorkspaceMembers(workspaceId),
      ]);
      setDetail(d);
      setRoster(m);
    } catch (e) {
      setError(errMessage(e, "Couldn't load the workspace."));
    } finally {
      setRefreshing(false);
    }
  }, [workspaceId]);

  useEffect(() => { void load(); }, [load]);

  const onRoleChange = useCallback(async (m: WorkspaceMember, role: WorkspaceRole) => {
    if (!workspaceId || (m.role || '').toUpperCase() === role) return;
    setActionError(null);
    setBusyKey(m.user_key);
    try {
      await updateMemberRole(workspaceId, m.user_key, role);
      await load(); // optimistic: reconcile to server truth
    } catch (e) {
      // Roll back: re-render from the (unchanged) server state we still hold,
      // and surface the guard (e.g. "Cannot change the role of the last owner.").
      setActionError(errMessage(e, "Couldn't change that member's role."));
      setRoster((r) => (r ? { ...r } : r));
    } finally {
      setBusyKey(null);
    }
  }, [workspaceId, load]);

  const confirmRemove = useCallback(async () => {
    if (!workspaceId || !pendingRemove) return;
    setRemoveError(null);
    setRemoving(true);
    try {
      await removeMember(workspaceId, pendingRemove.user_key);
      setPendingRemove(null);
      await load();
    } catch (e) {
      setRemoveError(errMessage(e, "Couldn't remove that member."));
    } finally {
      setRemoving(false);
    }
  }, [workspaceId, pendingRemove, load]);

  const loading = wsLoading || (detail === null && !error && !wsError);
  const fatalError = wsError || error;
  const canManage = roster?.can_manage ?? false;
  const members = roster?.members ?? [];

  // No workspace membership (resolved, but the user belongs to none).
  if (!wsLoading && !workspaceId && !wsError) {
    return (
      <div className="mx-auto max-w-[1000px] animate-fade-up">
        <Header />
        <div className="mt-6 rounded-token-lg border border-dashed border-subtle bg-surface-raised p-8 text-center text-sm text-tertiary">
          You&rsquo;re not a member of any workspace yet. Workspace access is granted through suite SSO.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1000px] animate-fade-up space-y-6">
      <Header
        onRefresh={() => void load()}
        refreshing={refreshing}
        refreshDisabled={!workspaceId}
        showRefresh={Boolean(detail)}
      />

      {/* ── Fatal error ── */}
      {fatalError && detail === null && (
        <div role="alert" className="flex items-start gap-3 rounded-token-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Couldn&rsquo;t load the workspace</p>
            <p className="mt-0.5 break-words text-danger/85">{fatalError}</p>
          </div>
          {!wsError && (
            <Button variant="secondary" size="sm" className="ml-auto shrink-0" onClick={() => void load()}>
              Retry
            </Button>
          )}
        </div>
      )}

      {loading ? (
        <WorkspaceSkeleton />
      ) : detail ? (
        <>
          {/* ── Identity card ── */}
          <section className="rounded-token-lg border border-subtle bg-surface-raised text-secondary shadow-token">
            <div className="flex flex-col gap-4 border-b border-subtle p-5 sm:flex-row sm:items-center">
              <IconTile icon={Building2} gradient="from-amber-400 to-orange-500" size="lg" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-primary">{detail.display_name}</h2>
                  <Badge variant={detail.status === 'active' ? 'success' : 'warning'} dot className="capitalize">
                    {detail.status}
                  </Badge>
                  {detail.hipaa_mode && <Badge variant="info">HIPAA</Badge>}
                  {detail.gdpr_mode && <Badge variant="info">GDPR</Badge>}
                  {detail.isolation_tier && detail.isolation_tier !== 'standard' && (
                    <Badge variant="accent" className="capitalize">{detail.isolation_tier}</Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-muted">{detail.slug}</p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
              <Field label="Members" value={detail.member_count} />
              <Field label="Your role" value={detail.your_role ? <span className="capitalize">{detail.your_role}</span> : '—'} />
              <Field label="Created" value={formatDate(detail.created_at) || '—'} />
              <Field label="Data residency" value={detail.data_residency || 'Default'} />
            </dl>
          </section>

          {/* ── Member roster ── */}
          <section className="rounded-token-lg border border-subtle bg-surface-raised text-secondary shadow-token">
            <div className="flex items-center justify-between gap-3 border-b border-subtle p-5">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-primary">Members</h2>
                <p className="mt-0.5 text-[13px] text-tertiary">
                  {canManage
                    ? 'You’re an owner — you can change roles and remove members. The suite enforces the rules.'
                    : 'Everyone with access to this workspace. Roles are managed by an owner.'}
                </p>
              </div>
              <span className="shrink-0 text-xs text-tertiary">{members.length} {members.length === 1 ? 'member' : 'members'}</span>
            </div>

            <div className="space-y-4 p-5">
              {/* Inline action error (the last-owner guard, a 403, etc.) */}
              {actionError && (
                <div role="alert" className="flex items-start gap-2 rounded-token border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
                  <span className="break-words">{actionError}</span>
                </div>
              )}

              {members.length > 0 ? (
                <ul className="space-y-2">
                  {members.map((m) => (
                    <MemberRow
                      key={m.user_key}
                      member={m}
                      canManage={canManage}
                      busy={busyKey === m.user_key}
                      onRoleChange={onRoleChange}
                      onRemove={(member) => { setRemoveError(null); setPendingRemove(member); }}
                    />
                  ))}
                </ul>
              ) : (
                <div className="rounded-token border border-dashed border-subtle bg-surface-overlay/40 p-6 text-center text-sm text-tertiary">
                  No members are listed for this workspace yet.
                </div>
              )}

              {canManage && workspaceId ? <OnboardingPanel workspaceId={workspaceId} /> : (
                <p className="text-sm text-secondary">Ask a workspace owner for an invitation. <Link className="text-accent underline" href="/invitations">Accept an invitation</Link></p>
              )}
            </div>
          </section>
        </>
      ) : null}

      {pendingRemove && (
        <RemoveMemberModal
          member={pendingRemove}
          error={removeError}
          busy={removing}
          onCancel={() => { if (!removing) { setPendingRemove(null); setRemoveError(null); } }}
          onConfirm={() => void confirmRemove()}
        />
      )}
    </div>
  );
}

/* ── the header (shared by the no-workspace + loaded states) ──────────────────── */
function Header({
  onRefresh,
  refreshing = false,
  refreshDisabled = false,
  showRefresh = false,
}: {
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  showRefresh?: boolean;
}) {
  return (
    <header className="co-glass co-glass-edge flex flex-col gap-4 rounded-token-lg p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <IconTile icon={Building2} gradient="from-amber-400 to-orange-500" size="lg" />
        <div className="min-w-0">
          <Link
            href="/dashboard/settings"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-tertiary transition-colors hover:text-primary"
          >
            <ArrowLeft className="h-3 w-3" strokeWidth={2.4} /> Settings
          </Link>
          <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-primary">Workspace</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-tertiary">
            Your workspace&rsquo;s identity and members. Each workspace stays fully separated — its own
            people, roles, and data.
          </p>
        </div>
      </div>
      {showRefresh && onRefresh && (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={onRefresh}
          disabled={refreshing || refreshDisabled}
          leading={<RefreshCw className={cn('h-4 w-4', refreshing && 'motion-safe:animate-spin')} strokeWidth={2.25} />}
        >
          Refresh
        </Button>
      )}
    </header>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Remove-member confirm — a focus-trapped dialog (useOverlay)
   ─────────────────────────────────────────────────────────────────────── */

function RemoveMemberModal({
  member,
  error,
  busy,
  onCancel,
  onConfirm,
}: {
  member: WorkspaceMember;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const headingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { panelRef, onKeyDown } = useOverlay({
    onClose: onCancel,
    closeOnEsc: !busy,
    initialFocusRef: cancelRef,
  });
  const name = memberName(member);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onKeyDown={onKeyDown}
    >
      <div className="absolute inset-0" onClick={busy ? undefined : onCancel} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="relative w-full max-w-lg rounded-token-lg border border-subtle bg-surface-raised p-6 text-secondary shadow-token-lg"
      >
        <div className="mb-4">
          <h3 id={headingId} className="text-base font-semibold text-primary">Remove member?</h3>
          <p className="mt-1 text-sm text-tertiary">
            <span className="font-medium text-secondary">{name}</span> will lose access to this workspace
            immediately. This doesn&rsquo;t delete their suite account — an owner can re-add them later.
          </p>
        </div>
        {error && (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-token border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
            <span className="break-words">{error}</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={busy}
            leading={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
          >
            {busy ? 'Removing…' : 'Remove member'}
          </Button>
        </div>
      </div>
    </div>
  );
}
