'use client';

/* =============================================================================
   Settings → API tokens (Personal Access Tokens)
   -----------------------------------------------------------------------------
   Ported from the Project-Ops reference, dressed in the Customer-Ops design
   system (token-driven surfaces, the house Button/Badge, no toast layer — we
   give inline feedback instead). Lets a user mint a `co_pat_` token for their
   own MCP client (Claude Code, ChatGPT, custom integrations) to talk to
   Customer-Ops directly, alongside the suite federation.

   Three states sit on top of one token list:
     - list (default): empty-state CTA or a table of the user's live PATs
     - create modal:  name + scope picker + expiry, submits to POST
     - reveal modal:  shows the plaintext token EXACTLY once, with a
                      copy-to-clipboard button and a FORCED acknowledge step

   The reveal modal is intentionally hard to dismiss without acknowledging —
   the plaintext is shown once and can never be retrieved again, so the user
   must explicitly confirm they've copied it before it closes. This is
   security-critical; do not soften it.
   ========================================================================== */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Check, Copy, KeyRound, Loader2, Plus, ShieldAlert, Trash2, X,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { IconTile } from '@/components/ui/IconTile';
import { apiGet, apiPost, apiDelete, ApiError } from '@/lib/api';
import { useOverlay } from '@/lib/useOverlay';
import { formatDate, formatDateTime } from '@/lib/format';

interface PatMetadata {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  workspaceId: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface CreatePatResult extends PatMetadata {
  plaintext: string;
}

/** Used until the live `/auth/pats/scopes` probe answers (and as a graceful
 *  fallback if it errors). Mirrors the Customer-Ops resource surface. */
const FALLBACK_SCOPES = [
  'read:customers',
  'write:customers',
  'read:activity',
  'write:activity',
  'read:leads',
  'write:leads',
  'read:overview',
  'run:agents',
];

/** The scopes a new token starts with — read-only, least-privilege defaults. */
const DEFAULT_SELECTED_SCOPES = ['read:customers', 'read:overview'];

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: '30 days', days: 30 },
  { label: '60 days', days: 60 },
  { label: '90 days', days: 90 },
  { label: '180 days', days: 180 },
  { label: '1 year', days: 365 },
  { label: 'Never', days: null },
];

/** Pull a human message off an ApiError (which already folds the server detail
 *  into its `.message`), falling back to a friendly default. */
function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function ApiTokensCard() {
  const [tokens, setTokens] = useState<PatMetadata[] | null>(null);
  const [scopes, setScopes] = useState<string[]>(FALLBACK_SCOPES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [revealed, setRevealed] = useState<CreatePatResult | null>(null);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [list, scopeList] = await Promise.all([
        apiGet<PatMetadata[]>('/auth/pats'),
        apiGet<{ scopes: string[] }>('/auth/pats/scopes').catch(() => null),
      ]);
      setTokens(list);
      if (scopeList?.scopes?.length) {
        setScopes(scopeList.scopes);
      }
    } catch (err) {
      setError(
        errMessage(err, "Couldn't load API tokens. Refresh the page or try again later."),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRevoke(id: string) {
    setRevokeError(null);
    try {
      await apiDelete(`/auth/pats/${id}`);
      setPendingRevokeId(null);
      void refresh();
    } catch (err) {
      setRevokeError(errMessage(err, 'Try again or refresh the page.'));
    }
  }

  const visibleTokens = useMemo(
    () => tokens?.filter((t) => !t.revokedAt) ?? [],
    [tokens],
  );

  return (
    <>
      <section className="rounded-token-lg border border-subtle bg-surface-raised text-secondary shadow-token">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-subtle p-5">
          <div className="flex min-w-0 items-start gap-3">
            <IconTile icon={KeyRound} gradient="from-emerald-400 to-teal-500" size="lg" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight text-primary">API tokens</h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-tertiary">
                Personal Access Tokens let your own MCP client (Claude Code, ChatGPT, custom
                integrations) talk to Customer-Ops directly, alongside the Unicorn Commander Suite
                federation.
              </p>
            </div>
          </div>
          {visibleTokens.length > 0 && !loading && !error && (
            <Button
              size="sm"
              className="shrink-0"
              onClick={() => setShowCreate(true)}
              leading={<Plus className="h-4 w-4" strokeWidth={2.25} />}
            >
              Create token
            </Button>
          )}
        </div>

        {/* Body */}
        <div className="p-5">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-tertiary">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading tokens…
            </div>
          ) : error ? (
            <div role="alert" className="flex items-start gap-3 rounded-token border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="break-words">{error}</p>
              </div>
              <Button variant="secondary" size="sm" className="ml-auto shrink-0" onClick={() => void refresh()}>
                Retry
              </Button>
            </div>
          ) : visibleTokens.length === 0 ? (
            <div className="rounded-token border border-dashed border-subtle bg-surface-overlay/40 p-8 text-center">
              <p className="mb-3 text-sm text-tertiary">
                No tokens yet. Create one to use Customer-Ops from your own MCP client.
              </p>
              <Button
                onClick={() => setShowCreate(true)}
                leading={<Plus className="h-4 w-4" strokeWidth={2.25} />}
              >
                Create your first token
              </Button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-token border border-subtle">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="[&_th]:bg-surface-overlay/70">
                    <th className="border-b border-subtle px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-tertiary">Name</th>
                    <th className="border-b border-subtle px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-tertiary">Scopes</th>
                    <th className="border-b border-subtle px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-tertiary">Last used</th>
                    <th className="border-b border-subtle px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-tertiary">Expires</th>
                    <th className="border-b border-subtle px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-tertiary">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTokens.map((token) => (
                    <tr key={token.id} className="[&_td]:transition-colors hover:[&_td]:bg-surface-overlay/40">
                      <td className="border-b border-subtle px-4 py-3 align-middle">
                        <div className="font-medium text-primary">{token.name}</div>
                        <div className="font-mono text-xs text-muted">{token.prefix}…</div>
                      </td>
                      <td className="border-b border-subtle px-4 py-3 align-middle">
                        <div className="flex flex-wrap gap-1">
                          {token.scopes.map((s) => (
                            <span
                              key={s}
                              className="rounded bg-surface-overlay px-1.5 py-0.5 font-mono text-xs text-tertiary"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="border-b border-subtle px-4 py-3 align-middle text-tertiary">
                        {token.lastUsedAt ? formatDateTime(token.lastUsedAt) : 'Never'}
                      </td>
                      <td className="border-b border-subtle px-4 py-3 align-middle text-tertiary">
                        {token.expiresAt ? formatDate(token.expiresAt) : 'Never'}
                      </td>
                      <td className="border-b border-subtle px-4 py-3 text-right align-middle">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setRevokeError(null); setPendingRevokeId(token.id); }}
                          leading={<Trash2 className="h-4 w-4" strokeWidth={2.25} />}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {showCreate && (
        <CreateTokenModal
          availableScopes={scopes}
          onClose={() => setShowCreate(false)}
          onCreated={(created) => {
            setShowCreate(false);
            setRevealed(created);
            void refresh();
          }}
        />
      )}

      {revealed && (
        <RevealTokenModal token={revealed} onAcknowledge={() => setRevealed(null)} />
      )}

      {pendingRevokeId && (
        <RevokeConfirmModal
          token={visibleTokens.find((t) => t.id === pendingRevokeId)}
          error={revokeError}
          onCancel={() => { setPendingRevokeId(null); setRevokeError(null); }}
          onConfirm={() => void handleRevoke(pendingRevokeId)}
        />
      )}
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Create modal
   ─────────────────────────────────────────────────────────────────────── */

function CreateTokenModal({
  availableScopes,
  onClose,
  onCreated,
}: {
  availableScopes: string[];
  onClose: () => void;
  onCreated: (created: CreatePatResult) => void;
}) {
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(DEFAULT_SELECTED_SCOPES);
  const [expiryDays, setExpiryDays] = useState<number | null>(90);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const headingId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  function toggleScope(scope: string) {
    setSelectedScopes((current) =>
      current.includes(scope)
        ? current.filter((s) => s !== scope)
        : [...current, scope],
    );
  }

  async function handleSubmit() {
    if (!name.trim()) {
      setFormError('Give the token a label so you can identify it later.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        scopes: selectedScopes,
      };
      if (expiryDays !== null) {
        body.expiresAt = new Date(Date.now() + expiryDays * 86_400_000).toISOString();
      }
      const created = await apiPost<CreatePatResult>('/auth/pats', body);
      onCreated(created);
    } catch (err) {
      setFormError(
        errMessage(err, 'The server rejected the request. Check the form and try again.'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell onClose={submitting ? undefined : onClose} labelledBy={headingId} initialFocusRef={nameRef}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 id={headingId} className="text-base font-semibold text-primary">Create API token</h3>
          <p className="mt-0.5 text-xs text-tertiary">
            Pick the scopes the token should be allowed to use, plus an expiry.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          disabled={submitting}
          className="text-tertiary transition-colors hover:text-primary disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="pat-name" className="text-xs font-medium text-secondary">
            Name
          </label>
          <input
            ref={nameRef}
            id="pat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Claude Code on Aaron's Mac"
            disabled={submitting}
            maxLength={100}
            className="w-full rounded-token border border-subtle bg-surface-overlay/50 px-3 py-2 text-sm text-primary placeholder:text-muted transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-secondary">Scopes</label>
          <div className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto rounded-token border border-subtle bg-surface-overlay/30 p-3 sm:grid-cols-2">
            {availableScopes.map((scope) => (
              <label key={scope} className="flex cursor-pointer items-center gap-2 text-sm text-secondary">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[rgb(var(--co-accent))]"
                  checked={selectedScopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  disabled={submitting}
                />
                <span className="font-mono">{scope}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-tertiary">
            Scopes are enforced on every call this token makes — REST and MCP — and the token is
            bound to one workspace. A write scope also grants the matching read. Your own sign-in
            session is unaffected.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-secondary">Expires</label>
          <div className="flex flex-wrap gap-2">
            {EXPIRY_OPTIONS.map((opt) => {
              const active = expiryDays === opt.days;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setExpiryDays(opt.days)}
                  disabled={submitting}
                  className={
                    active
                      ? 'rounded-token border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-accent-contrast transition-colors disabled:opacity-50'
                      : 'rounded-token border border-subtle bg-surface-overlay/50 px-3 py-1.5 text-sm text-secondary transition-colors hover:bg-surface-elevated hover:text-primary disabled:opacity-50'
                  }
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {expiryDays === null && (
            <p className="flex items-center gap-1 text-xs text-warning">
              <ShieldAlert className="h-3 w-3" />
              Tokens that never expire are convenient but a long-term audit risk. Prefer a finite
              lifetime.
            </p>
          )}
        </div>

        {formError && (
          <div role="alert" className="flex items-start gap-2 rounded-token border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
            <span className="break-words">{formError}</span>
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          disabled={submitting}
          leading={submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
        >
          {submitting ? 'Creating…' : 'Create token'}
        </Button>
      </div>
    </ModalShell>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Reveal modal — plaintext shown exactly once
   ─────────────────────────────────────────────────────────────────────── */

function RevealTokenModal({
  token,
  onAcknowledge,
}: {
  token: CreatePatResult;
  onAcknowledge: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const headingId = useId();
  const copyBtnRef = useRef<HTMLButtonElement>(null);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token.plaintext);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    // Deliberately no close button and no overlay-dismiss — the user MUST
    // acknowledge they've copied the token before this can close.
    <ModalShell onClose={undefined} labelledBy={headingId} initialFocusRef={copyBtnRef}>
      <div className="mb-4">
        <div className="mb-2 flex items-center gap-2">
          <Check className="h-5 w-5 text-success" />
          <h3 id={headingId} className="text-base font-semibold text-primary">Token created</h3>
        </div>
        <p className="text-sm text-tertiary">
          Copy this token now. <strong className="text-secondary">It will never be shown again.</strong>{' '}
          If you lose it, revoke it and create a new one.
        </p>
      </div>

      <div className="space-y-3">
        <div className="select-all break-all rounded-token border border-subtle bg-surface-overlay/50 p-3 font-mono text-sm text-primary">
          {token.plaintext}
        </div>

        <Button ref={copyBtnRef} variant="secondary" block onClick={() => void handleCopy()}>
          {copied ? (
            <>
              <Check className="mr-2 h-4 w-4 text-success" />
              Copied
            </>
          ) : (
            <>
              <Copy className="mr-2 h-4 w-4" />
              Copy to clipboard
            </>
          )}
        </Button>

        {copyFailed && (
          <p className="text-xs text-warning">
            Couldn&rsquo;t copy automatically — select the token text above and copy it manually.
          </p>
        )}

        <div className="flex items-start gap-2 rounded-token border border-warning/40 bg-warning-subtle p-3 text-xs">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium text-warning">Treat this token like a password.</p>
            <p className="text-tertiary">
              Anyone with it can act as you against Customer-Ops, scoped to:{' '}
              <span className="font-mono">{token.scopes.join(', ') || '(no scopes)'}</span>.
            </p>
          </div>
        </div>

        <label className="flex items-center gap-2 pt-1 text-sm text-secondary">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[rgb(var(--co-accent))]"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I&rsquo;ve copied the token somewhere safe.
        </label>
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <Button onClick={onAcknowledge} disabled={!acknowledged}>
          Done
        </Button>
      </div>
    </ModalShell>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Revoke confirm
   ─────────────────────────────────────────────────────────────────────── */

function RevokeConfirmModal({
  token,
  error,
  onCancel,
  onConfirm,
}: {
  token: PatMetadata | undefined;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const headingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalShell onClose={onCancel} labelledBy={headingId} initialFocusRef={cancelRef}>
      <div className="mb-4">
        <h3 id={headingId} className="text-base font-semibold text-primary">Revoke token?</h3>
        <p className="mt-1 text-sm text-tertiary">
          {token ? (
            <>
              <span className="font-medium text-secondary">{token.name}</span> will stop working
              immediately for any MCP client using it. This cannot be undone.
            </>
          ) : (
            'This token will stop working immediately. This cannot be undone.'
          )}
        </p>
      </div>
      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-token border border-danger/30 bg-danger-subtle px-3 py-2 text-xs text-danger">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
          <span className="break-words">{error}</span>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Revoke token
        </Button>
      </div>
    </ModalShell>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   Shared modal shell
   ─────────────────────────────────────────────────────────────────────── */

function ModalShell({
  children,
  onClose,
  labelledBy,
  initialFocusRef,
}: {
  children: React.ReactNode;
  /** Dismiss handler (scrim click + Esc). Omit to force an explicit action
   *  (the reveal modal — its only way out is the acknowledge checkbox + Done). */
  onClose?: () => void;
  /** Id of the heading element that names the dialog. */
  labelledBy: string;
  /** Element to focus on open (else the panel's first focusable). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  // A no-op close keeps the trap/scroll-lock/focus-restore behaviour while
  // disabling Esc for the must-acknowledge reveal modal.
  const { panelRef, onKeyDown } = useOverlay({
    onClose: onClose ?? (() => {}),
    closeOnEsc: Boolean(onClose),
    initialFocusRef,
  });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onKeyDown={onKeyDown}
    >
      {/* Overlay click closes only when onClose is provided (the reveal modal
          omits it to force explicit acknowledgement). */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="relative w-full max-w-lg rounded-token-lg border border-subtle bg-surface-raised p-6 text-secondary shadow-token-lg"
      >
        {children}
      </div>
    </div>
  );
}
