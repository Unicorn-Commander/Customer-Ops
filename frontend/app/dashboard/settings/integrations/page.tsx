'use client';

/* =============================================================================
   Settings → Integrations — the live federation connections
   -----------------------------------------------------------------------------
   Customer-Ops is a surface, not an engine: it owns the relationship and
   federates everything else from the six sibling apps over typed seams. This
   page reads the GLOBAL `GET /health/integrations` probe and renders each seam
   as a card — its display name, what it federates, an honest status badge
   (Connected / Needs setup / Unreachable / Not connected), and connection
   guidance.

   It is deliberately HONEST: integrations are wired at the infrastructure level
   (env + the sibling app), so this is operator/admin status + guidance, NOT a
   click-to-connect surface. No fake toggles; we never claim a seam is connected
   when it isn't — the badge comes straight from the live probe.
   ========================================================================== */

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Network, RefreshCw, AlertCircle, Plug, CheckCircle2, BookOpen, ArrowLeft, X,
} from 'lucide-react';
import { Badge, Button, cn } from '@/components/ui';
import { IconTile } from '@/components/ui/IconTile';
import {
  getIntegrationsHealth, seamStatus, seamCopy, latencyLabel,
  type SeamHealth,
} from '@/lib/integrations';
import { M365ConnectCard } from '@/components/integrations/M365ConnectCard';

/* The README's "How it federates" section — operator guidance lives there. */
const FEDERATES_GUIDE =
  'https://docs.customer-ops.example.com#how-it-federates';

/* ── a single seam card ─────────────────────────────────────────────────────── */
function SeamCard({ seam }: { seam: SeamHealth }) {
  const copy = seamCopy(seam.seam);
  const status = seamStatus(seam);
  const connected = status.status === 'connected';

  return (
    <div className="flex flex-col rounded-token-lg border border-subtle bg-surface-raised text-secondary shadow-token">
      {/* Header: icon + name + status badge */}
      <div className="flex items-start justify-between gap-3 border-b border-subtle p-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconTile icon={Plug} gradient={copy.gradient} size="md" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-primary">{copy.name}</h3>
            <p className="truncate text-[11px] text-tertiary">{copy.sourceOfTruth}</p>
          </div>
        </div>
        <Badge variant={status.variant} dot className="shrink-0">{status.label}</Badge>
      </div>

      {/* Body: what it federates + the honest connection note */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <p className="text-[13px] leading-relaxed text-secondary">{copy.federates}</p>

        {connected ? (
          <div className="mt-auto flex items-center gap-2 rounded-token border border-subtle bg-surface-overlay/40 px-3 py-2 text-xs text-tertiary">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2.25} />
            <span>
              Working — data flows into each customer&rsquo;s profile as it lands.
              <span className="ml-1 font-mono text-muted tabular-nums">{latencyLabel(seam.latencyMs)}</span>
            </span>
          </div>
        ) : (
          <div className="mt-auto flex items-start gap-2.5 rounded-token border border-dashed border-subtle bg-surface-overlay/40 px-3.5 py-3">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-token bg-warning-subtle text-warning">
              <Plug className="h-[15px] w-[15px]" strokeWidth={2.25} />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-secondary">How to connect</p>
              <p className="mt-0.5 text-xs leading-relaxed text-tertiary">
                {status.status === 'needs-setup'
                  ? 'Reachable, but the credential is wrong or missing. An operator re-checks this seam’s service token, then it connects automatically.'
                  : status.status === 'unreachable'
                  ? 'The target app didn’t answer. An operator confirms it’s running and the URL is right, then it connects automatically.'
                  : 'No target is wired in yet. An operator sets this seam’s URL + token (env + the sibling app), then it connects automatically.'}
              </p>
              <p className="mt-1.5 text-[11px] text-muted">
                Configured at the infrastructure level — self-serve connect is coming.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── loading skeleton ───────────────────────────────────────────────────────── */
function SeamSkeleton() {
  return (
    <div className="rounded-token-lg border border-subtle bg-surface-raised p-4">
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 animate-pulse rounded-[10px] bg-surface-overlay" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-28 animate-pulse rounded bg-surface-overlay" />
          <div className="h-2.5 w-20 animate-pulse rounded bg-surface-overlay" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-surface-overlay" />
        <div className="h-10 w-full animate-pulse rounded bg-surface-overlay" />
      </div>
    </div>
  );
}

/* ── Microsoft 365 OAuth return banner ───────────────────────────────────────
   The connector's callback 302s back to this page with ?m365=connected|error.
   Read it (the SSO-callback pattern) and show a dismissible banner. Reads
   useSearchParams, so it lives inside a Suspense boundary (Next 15 requirement). */
function M365ReturnBanner() {
  const params = useSearchParams();
  const outcome = params.get('m365');
  const [dismissed, setDismissed] = useState(false);

  if (!outcome || dismissed) return null;
  const ok = outcome === 'connected';

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 rounded-token-lg border px-4 py-3 text-sm',
        ok
          ? 'border-success/30 bg-success-subtle text-success'
          : 'border-warning/30 bg-warning-subtle text-warning',
      )}
    >
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
      ) : (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {ok ? 'Microsoft 365 connected' : 'Microsoft 365 didn’t connect'}
        </p>
        <p className="mt-0.5 opacity-90">
          {ok
            ? 'Your account is linked. Use “Sync now” on the Microsoft 365 card to import your contacts.'
            : 'The connection wasn’t completed. You can try again from the Microsoft 365 card below.'}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="ml-auto shrink-0 rounded-token p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
      >
        <X className="h-4 w-4" strokeWidth={2.25} />
      </button>
    </div>
  );
}

/* ── the page ───────────────────────────────────────────────────────────────── */
function IntegrationsPageInner() {
  const [seams, setSeams] = useState<SeamHealth[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const res = await getIntegrationsHealth();
      setSeams(res.seams);
      setCheckedAt(res.checkedAt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loading = seams === null && !error;
  // The `m365` seam has its own interactive M365ConnectCard (click-to-connect),
  // so drop it from the generic read-only grid to avoid a duplicate tile.
  const gridSeams = seams?.filter((s) => s.seam !== 'm365') ?? null;
  const connectedCount = seams?.filter((s) => seamStatus(s).status === 'connected').length ?? 0;

  return (
    <div className="mx-auto max-w-[1200px] animate-fade-up space-y-6">
      {/* ── Header ── */}
      <header className="co-glass co-glass-edge flex flex-col gap-4 rounded-token-lg p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <IconTile icon={Network} gradient="from-cyan-400 to-blue-500" size="lg" />
          <div className="min-w-0">
            <Link
              href="/dashboard/settings"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-tertiary transition-colors hover:text-primary"
            >
              <ArrowLeft className="h-3 w-3" strokeWidth={2.4} /> Settings
            </Link>
            <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-primary">Integrations</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-tertiary">
              Customer-Ops federates your suite — these are the live connections. Data appears in each
              customer&rsquo;s profile as it flows in. Nothing is copied; you always see the real source.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {seams && (
            <span className="hidden text-xs text-tertiary sm:inline">
              {connectedCount} of {seams.length} connected
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load()}
            disabled={refreshing}
            leading={<RefreshCw className={cn('h-4 w-4', refreshing && 'motion-safe:animate-spin')} strokeWidth={2.25} />}
          >
            Refresh
          </Button>
        </div>
      </header>

      {/* ── Microsoft 365 OAuth return banner (?m365=connected|error) ── */}
      <M365ReturnBanner />

      {/* ── Error ── */}
      {error && seams === null && (
        <div className="flex items-start gap-3 rounded-token-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Couldn&rsquo;t load integration status</p>
            <p className="mt-0.5 break-words text-danger/85">{error}</p>
          </div>
          <Button variant="secondary" size="sm" className="ml-auto shrink-0" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      {/* ── Seam grid ── The Microsoft 365 connect card leads (it's the one
          click-to-connect integration); the rest are the read-only federation seams. */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <M365ConnectCard />
          {[0, 1, 2, 3, 4].map((i) => <SeamSkeleton key={i} />)}
        </div>
      ) : gridSeams ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <M365ConnectCard />
          {gridSeams.map((s) => <SeamCard key={s.seam} seam={s} />)}
        </div>
      ) : seams ? (
        <div className="rounded-token-lg border border-subtle bg-surface-raised p-8 text-center text-sm text-tertiary">
          No federation seams are reporting. The cockpit still runs on its own — seams are optional and degrade clean.
        </div>
      ) : null}

      {/* ── Footer: honest guidance + last-checked ── */}
      {seams && (
        <div className="flex flex-col gap-3 rounded-token-lg border border-subtle bg-surface-raised p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-tertiary">
            <Plug className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={2.25} />
            <span>
              Microsoft 365 connects from here. The federation seams are configured at the
              infrastructure level (env + the sibling app), so connecting one is an operator task.
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-3">
            {checkedAt && (
              <span className="text-[11px] text-muted">
                Checked {new Date(checkedAt).toLocaleTimeString()}
              </span>
            )}
            <a
              href={FEDERATES_GUIDE}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-token border border-subtle bg-surface-overlay px-3 py-1.5 text-xs font-medium text-secondary transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <BookOpen className="h-3.5 w-3.5" strokeWidth={2.25} /> How it federates
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

/* The page reads ?m365= via useSearchParams (in the banner), so the tree is
   wrapped in a Suspense boundary — Next 15's requirement for useSearchParams. */
export default function IntegrationsPage() {
  return (
    <Suspense fallback={null}>
      <IntegrationsPageInner />
    </Suspense>
  );
}
