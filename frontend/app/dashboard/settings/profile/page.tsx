'use client';

/* =============================================================================
   Settings → Profile — who you are, across the suite
   -----------------------------------------------------------------------------
   Identity in Customer-Ops is SSO-managed: the suite owns your name, email, and
   sign-in, and this cockpit only reads the projection. So this is deliberately a
   VIEW — no edit form (that would be a fake control). It shows your identity
   card, an honest note that changes happen in suite SSO, and the workspaces you
   belong to. The voice stays plain + sovereign, matching the rest of Settings.
   ========================================================================== */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  UserCircle, ArrowLeft, AlertCircle, ShieldCheck, Building2, LogOut,
} from 'lucide-react';
import { Badge, Button } from '@/components/ui';
import { IconTile } from '@/components/ui/IconTile';
import { clearSession } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import { getProfile, getMyWorkspaces, profileName, type Profile } from '@/lib/profile';
import type { MyWorkspace } from '@/lib/api';

/** First letter of the display name (a single-glyph avatar). */
function avatarGlyph(name: string): string {
  const ch = name.trim()[0];
  return ch ? ch.toUpperCase() : '·';
}

/* ── a labelled identity field (term + value) ─────────────────────────────────── */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-tertiary">{label}</dt>
      <dd className="mt-1 truncate text-sm text-primary">{value}</dd>
    </div>
  );
}

/* ── loading skeleton ─────────────────────────────────────────────────────────── */
function ProfileSkeleton() {
  return (
    <>
      <div className="rounded-token-lg border border-subtle bg-surface-raised p-5">
        <div className="flex items-center gap-4">
          <div className="h-16 w-16 animate-pulse rounded-full bg-surface-overlay" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-40 animate-pulse rounded bg-surface-overlay" />
            <div className="h-3 w-56 animate-pulse rounded bg-surface-overlay" />
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
        <div className="h-3 w-32 animate-pulse rounded bg-surface-overlay" />
        <div className="mt-4 space-y-2">
          <div className="h-12 w-full animate-pulse rounded bg-surface-overlay" />
          <div className="h-12 w-full animate-pulse rounded bg-surface-overlay" />
        </div>
      </div>
    </>
  );
}

/* ── the page ───────────────────────────────────────────────────────────────── */
export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [workspaces, setWorkspaces] = useState<MyWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([getProfile(), getMyWorkspaces()])
      .then(([p, ws]) => {
        if (cancelled) return;
        setProfile(p);
        setWorkspaces(ws);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => { cancelled = true; };
  }, []);

  const loading = profile === null && !error;

  function signOut() {
    clearSession();
    window.location.assign('/auth/login');
  }

  return (
    <div className="mx-auto max-w-[1000px] animate-fade-up space-y-6">
      {/* ── Header ── */}
      <header className="co-glass co-glass-edge flex flex-col gap-4 rounded-token-lg p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <IconTile icon={UserCircle} gradient="from-violet-500 to-fuchsia-500" size="lg" />
          <div className="min-w-0">
            <Link
              href="/dashboard/settings"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-tertiary transition-colors hover:text-primary"
            >
              <ArrowLeft className="h-3 w-3" strokeWidth={2.4} /> Settings
            </Link>
            <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-primary">Profile</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-tertiary">
              Who you are across the suite. Your identity is managed through Unicorn Commander SSO —
              this cockpit reads it, it never owns it.
            </p>
          </div>
        </div>
        {profile && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={signOut}
            leading={<LogOut className="h-4 w-4" strokeWidth={2.25} />}
          >
            Sign out
          </Button>
        )}
      </header>

      {/* ── Error ── */}
      {error && profile === null && (
        <div role="alert" className="flex items-start gap-3 rounded-token-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Couldn&rsquo;t load your profile</p>
            <p className="mt-0.5 break-words text-danger/85">{error}</p>
          </div>
        </div>
      )}

      {loading ? (
        <ProfileSkeleton />
      ) : profile ? (
        <>
          {/* ── Identity card ── */}
          <section className="rounded-token-lg border border-subtle bg-surface-raised text-secondary shadow-token">
            <div className="flex flex-col gap-4 border-b border-subtle p-5 sm:flex-row sm:items-center">
              <span className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-2xl font-bold text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_3px_8px_-2px_rgba(0,0,0,0.45)]">
                {avatarGlyph(profileName(profile))}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-primary">{profileName(profile)}</h2>
                  <Badge variant={profile.isActive ? 'success' : 'neutral'} dot>
                    {profile.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-[13px] text-tertiary">{profile.email}</p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
              <Field label="Username" value={<span className="font-mono text-[13px]">{profile.username}</span>} />
              <Field label="Email" value={profile.email} />
              <Field label="Member since" value={formatDate(profile.createdAt) || '—'} />
              <Field label="Last sign-in" value={relativeTime(profile.lastLoginAt)} />
            </dl>
          </section>

          {/* ── SSO note ── */}
          <div className="flex items-start gap-2.5 rounded-token-lg border border-dashed border-subtle bg-surface-overlay/40 px-4 py-3.5">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-token bg-info-subtle text-info">
              <ShieldCheck className="h-[15px] w-[15px]" strokeWidth={2.25} />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-secondary">Identity is managed through suite SSO</p>
              <p className="mt-0.5 text-xs leading-relaxed text-tertiary">
                Your name, email, and sign-in are set in Unicorn Commander&rsquo;s single sign-on, not here —
                so they stay consistent across every app in the suite. Change them there and they update
                automatically. Customer-Ops only reflects what SSO reports.
              </p>
            </div>
          </div>

          {/* ── Workspaces ── */}
          <section className="rounded-token-lg border border-subtle bg-surface-raised text-secondary shadow-token">
            <div className="flex items-center gap-3 border-b border-subtle p-5">
              <IconTile icon={Building2} gradient="from-amber-400 to-orange-500" size="md" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-primary">Your workspaces</h2>
                <p className="mt-0.5 text-[13px] text-tertiary">
                  The workspaces you belong to and your role in each. Each one stays fully separated.
                </p>
              </div>
            </div>
            <div className="p-5">
              {workspaces && workspaces.length > 0 ? (
                <ul className="space-y-2">
                  {workspaces.map((ws) => (
                    <li
                      key={ws.workspace_id}
                      className="flex items-center justify-between gap-3 rounded-token border border-subtle bg-surface-overlay/40 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-primary">{ws.display_name}</span>
                          {ws.is_default && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-xs text-muted">{ws.slug}</p>
                      </div>
                      <Badge variant="neutral" className="shrink-0 capitalize">{ws.role}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-token border border-dashed border-subtle bg-surface-overlay/40 p-6 text-center text-sm text-tertiary">
                  You&rsquo;re not a member of any workspace yet. Workspace access is granted through suite SSO.
                </div>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
