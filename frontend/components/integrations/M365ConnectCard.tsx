'use client';

/* =============================================================================
   M365ConnectCard — the suite's FIRST click-to-connect integration.
   -----------------------------------------------------------------------------
   Every other seam on the Integrations page is operator-configured (env + the
   sibling app), so its card is read-only status. Microsoft 365 is different: a
   signed-in user links their OWN account via OAuth and pulls their Outlook
   contacts into the cockpit (funneled through lead-intake). So this card owns the
   full lifecycle — connect / sync now / disconnect — while staying HONEST:

     • dormant (deployment didn't set M365_CLIENT_ID) → a calm disabled state,
       "Microsoft 365 isn't configured on this deployment";
     • configured, not linked → a "Connect Microsoft 365" button;
     • linked → the account, last-sync, "Sync now" + "Disconnect".

   It matches the SeamCard visual language so it reads as one grid with the others.
   ========================================================================== */

import { useCallback, useEffect, useState } from 'react';
import { Plug, RefreshCw, LinkIcon, Unplug, CheckCircle2, AlertCircle, Mail } from 'lucide-react';
import { Badge, Button, cn } from '@/components/ui';
import { IconTile } from '@/components/ui/IconTile';
import { ApiError } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import {
  getM365Status,
  startM365Connect,
  syncM365Contacts,
  disconnectM365,
  type M365Status,
} from '@/lib/m365';

const GRADIENT = 'from-sky-500 to-indigo-500';

/** A small inline status line (last sync result / error). */
function SyncLine({ status }: { status: M365Status }) {
  const c = status.connection;
  if (!c) return null;
  if (c.status === 'REVOKED') {
    return (
      <p className="flex items-start gap-1.5 text-xs text-warning">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
        Access was revoked in Microsoft 365 — reconnect to resume syncing.
      </p>
    );
  }
  if (c.status === 'ERROR' && c.lastSyncError) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-danger">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
        Last sync failed: {c.lastSyncError}
      </p>
    );
  }
  if (c.lastSyncAt) {
    return (
      <p className="text-xs text-tertiary">
        Last synced {relativeTime(c.lastSyncAt)}
        {c.lastSyncStatus ? ` · ${c.lastSyncStatus}` : ''}
      </p>
    );
  }
  return <p className="text-xs text-tertiary">Connected — run a sync to import your contacts.</p>;
}

export function M365ConnectCard() {
  const [status, setStatus] = useState<M365Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'connect' | 'sync' | 'disconnect'>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setStatus(await getM365Status());
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onConnect = useCallback(async () => {
    setBusy('connect');
    setActionMsg(null);
    try {
      const { url } = await startM365Connect();
      window.location.href = url; // hand off to Microsoft consent
    } catch (e) {
      setActionMsg(e instanceof ApiError ? e.message : 'Could not start the connect flow.');
      setBusy(null);
    }
  }, []);

  const onSync = useCallback(async () => {
    setBusy('sync');
    setActionMsg(null);
    try {
      const res = await syncM365Contacts();
      setActionMsg(
        res.ok
          ? `Imported ${res.ingested} of ${res.contactsSeen} contact(s)${res.failed ? `, ${res.failed} failed` : ''}.`
          : `Sync didn't complete: ${res.detail}`,
      );
      await load();
    } catch (e) {
      setActionMsg(e instanceof ApiError ? e.message : 'Sync failed.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const onDisconnect = useCallback(async () => {
    setBusy('disconnect');
    setActionMsg(null);
    try {
      await disconnectM365();
      setActionMsg('Disconnected.');
      await load();
    } catch (e) {
      setActionMsg(e instanceof ApiError ? e.message : 'Could not disconnect.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const configured = status?.configured ?? false;
  const connected = status?.connected ?? false;
  const badge = !status
    ? { label: 'Loading…', variant: 'neutral' as const }
    : !configured
    ? { label: 'Not configured', variant: 'neutral' as const }
    : connected
    ? status.connection?.status === 'REVOKED'
      ? { label: 'Needs reconnect', variant: 'warning' as const }
      : { label: 'Connected', variant: 'success' as const }
    : { label: 'Not connected', variant: 'neutral' as const };

  return (
    <div className="flex flex-col rounded-token-lg border border-subtle bg-surface-raised text-secondary shadow-token">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-subtle p-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconTile icon={Mail} gradient={GRADIENT} size="md" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-primary">Microsoft 365</h3>
            <p className="truncate text-[11px] text-tertiary">your Outlook contacts</p>
          </div>
        </div>
        <Badge variant={badge.variant} dot className="shrink-0">
          {badge.label}
        </Badge>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <p className="text-[13px] leading-relaxed text-secondary">
          Link your Microsoft 365 account to import your Outlook contacts as leads — each flows through
          the same pipeline as every other source. Nothing is copied twice; identity resolves in
          Contact-Ops.
        </p>

        {/* ── Dormant: not configured on this deployment ── */}
        {status && !configured && (
          <div className="mt-auto flex items-start gap-2.5 rounded-token border border-dashed border-subtle bg-surface-overlay/40 px-3.5 py-3">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-token bg-surface-overlay text-muted">
              <Plug className="h-[15px] w-[15px]" strokeWidth={2.25} />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-secondary">Not available here</p>
              <p className="mt-0.5 text-xs leading-relaxed text-tertiary">
                Microsoft 365 isn&rsquo;t configured on this deployment. An operator adds the Azure app
                credentials, then this becomes a one-click connect.
              </p>
            </div>
          </div>
        )}

        {/* ── Configured, not connected ── */}
        {status && configured && !connected && (
          <div className="mt-auto space-y-2">
            <Button
              variant="primary"
              size="sm"
              onClick={onConnect}
              disabled={busy !== null}
              leading={<LinkIcon className="h-4 w-4" strokeWidth={2.25} />}
            >
              {busy === 'connect' ? 'Redirecting…' : 'Connect Microsoft 365'}
            </Button>
          </div>
        )}

        {/* ── Connected ── */}
        {status && configured && connected && status.connection && (
          <div className="mt-auto space-y-3">
            <div className="flex items-center gap-2 rounded-token border border-subtle bg-surface-overlay/40 px-3 py-2 text-xs">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2.25} />
              <span className="min-w-0 truncate text-secondary">
                {status.connection.m365UserPrincipal ?? 'Microsoft 365 account'}
              </span>
            </div>
            <SyncLine status={status} />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onSync}
                disabled={busy !== null}
                leading={
                  <RefreshCw
                    className={cn('h-4 w-4', busy === 'sync' && 'motion-safe:animate-spin')}
                    strokeWidth={2.25}
                  />
                }
              >
                {busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDisconnect}
                disabled={busy !== null}
                leading={<Unplug className="h-4 w-4" strokeWidth={2.25} />}
              >
                Disconnect
              </Button>
            </div>
          </div>
        )}

        {/* Inline action result / error */}
        {actionMsg && <p className="text-xs text-tertiary">{actionMsg}</p>}
        {loadError && (
          <p className="flex items-start gap-1.5 text-xs text-danger">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
            {loadError}
          </p>
        )}
      </div>
    </div>
  );
}
