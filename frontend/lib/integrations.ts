/**
 * Federation integrations model — the typed view over `GET /health/integrations`.
 *
 * Customer-Ops is a surface, not an engine: it owns the relationship and
 * federates everything else from the six sibling apps over typed MCP seams. The
 * backend probes each seam (a side-effect-free `tools/list` over the SAME
 * transport/auth a real read uses) and reports its health, so a silent auth
 * failure can never hide behind a degrade-clean empty panel.
 *
 * This is the one place that:
 *   • fetches the global (NOT workspace-scoped) health route,
 *   • maps each seam's raw `{ ok, configured, detail }` to a human status, and
 *   • carries the per-seam display copy (name + what it federates).
 *
 * Pure data + pure helpers — no React, so the Integrations page and any future
 * surface (a status widget, the command palette) can import it freely.
 */
import { API_BASE } from './api';

/* ── the raw shape the backend returns ──────────────────────────────────────
   Mirrors `backend/src/health/seam-health.ts` (SeamHealth) 1:1. */
export interface SeamHealth {
  /** The seam identity, e.g. 'contact-ops' | 'accounting-ops' | 'email-ops'. */
  seam: string;
  /** Whether a target is configured at all (the seam's BASE_URL is set). */
  configured: boolean;
  /** True iff a live probe authenticated (HTTP 200 to `tools/list`). */
  ok: boolean;
  /** HTTP status of the probe; null when no probe was attempted. */
  status: number | null;
  /** 'ok' | 'not-configured' | 'auth-error: <msg>' | 'unreachable: <msg>'. */
  detail: string;
  /** Probe round-trip in ms; null when no probe was attempted. */
  latencyMs: number | null;
}

export interface IntegrationsHealth {
  seams: SeamHealth[];
  checkedAt: string;
}

/* ── the resolved, display-ready status ─────────────────────────────────────── */

/** The four states a seam can present, derived from `{ ok, configured, detail }`. */
export type SeamStatus = 'connected' | 'needs-setup' | 'unreachable' | 'not-connected';

export interface SeamStatusMeta {
  status: SeamStatus;
  /** The human label shown on the badge. */
  label: string;
  /** Badge variant (maps onto the design-system status tokens). */
  variant: 'success' | 'warning' | 'danger' | 'neutral';
}

const STATUS_META: Record<SeamStatus, SeamStatusMeta> = {
  connected: { status: 'connected', label: 'Connected', variant: 'success' },
  'needs-setup': { status: 'needs-setup', label: 'Needs setup', variant: 'warning' },
  unreachable: { status: 'unreachable', label: 'Unreachable', variant: 'danger' },
  'not-connected': { status: 'not-connected', label: 'Not connected', variant: 'neutral' },
};

/**
 * Map a seam's raw probe result to its display status, honestly.
 *
 *   • configured + ok                 → Connected (green)   — authenticated, working.
 *   • configured + detail auth-error  → Needs setup (amber) — reachable but the
 *                                        token is wrong/missing (operator must fix).
 *   • configured + (not ok)           → Unreachable (red)   — the target is down or
 *                                        erroring (any non-auth failure).
 *   • not configured                  → Not connected (muted) — no target wired in.
 *
 * The auth-error case is checked off `detail` (the backend prefixes it
 * `auth-error: …`), because both an auth failure and an outage land as `ok:false`.
 */
export function seamStatus(seam: SeamHealth): SeamStatusMeta {
  if (!seam.configured) return STATUS_META['not-connected'];
  if (seam.ok) return STATUS_META.connected;
  if (seam.detail?.startsWith('auth-error')) return STATUS_META['needs-setup'];
  return STATUS_META.unreachable;
}

/* ── per-seam display copy ───────────────────────────────────────────────────
   Keyed by the seam identity the backend reports. Faithful to README §"How it
   federates" — the source of truth + the one-line "what it federates". */
export interface SeamCopy {
  /** Display name (e.g. "Contact-Ops"). */
  name: string;
  /** One line: what this seam federates into a customer's profile. */
  federates: string;
  /** The source of truth this seam reads from. */
  sourceOfTruth: string;
  /** Two-stop gradient for the seam's IconTile — echoes the cockpit language. */
  gradient: string;
}

export const SEAM_COPY: Record<string, SeamCopy> = {
  'contact-ops': {
    name: 'Contact-Ops',
    federates: 'Contacts & orgs — the one canonical phonebook for the suite.',
    sourceOfTruth: 'the one canonical phonebook',
    gradient: 'from-violet-500 to-fuchsia-500',
  },
  'accounting-ops': {
    name: 'Accounting-Ops',
    federates: 'Invoices & AR status, live from the one billing engine.',
    sourceOfTruth: 'the AR / invoicing engine',
    gradient: 'from-amber-400 to-orange-500',
  },
  'email-ops': {
    name: 'Email-Ops',
    federates: 'Mailbox threads & send, from the shared mail surface.',
    sourceOfTruth: 'the mail surface',
    gradient: 'from-sky-400 to-blue-500',
  },
  'meeting-ops': {
    name: 'Meeting-Ops',
    federates: 'Meetings, summaries & action items from conversation intelligence.',
    sourceOfTruth: 'conversation intelligence',
    gradient: 'from-cyan-400 to-blue-500',
  },
  'project-ops': {
    name: 'Project-Ops',
    federates: 'Projects & delivery status from project operations.',
    sourceOfTruth: 'project & client operations',
    gradient: 'from-lime-400 to-emerald-500',
  },
  'outreach-ops': {
    name: 'Outreach',
    federates: 'Campaigns & social touches from the outreach surface.',
    sourceOfTruth: 'the outreach surface',
    gradient: 'from-fuchsia-500 to-pink-500',
  },
};

/** Display copy for a seam, with a safe fallback for an unknown identity. */
export function seamCopy(seam: string): SeamCopy {
  return (
    SEAM_COPY[seam] ?? {
      name: seam,
      federates: 'A federated suite app.',
      sourceOfTruth: 'the source app',
      gradient: 'from-slate-400 to-slate-500',
    }
  );
}

/**
 * Fetch federation seam health. This route is GLOBAL (not workspace-scoped) and
 * unauthenticated like the other `/health/*` probes — it reports only seam
 * up/down + a short detail, never tenant data — so we hit it directly rather
 * than going through `apiGet` (which would attach a bearer + bounce on 401).
 */
export async function getIntegrationsHealth(): Promise<IntegrationsHealth> {
  const res = await fetch(`${API_BASE}/health/integrations`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`GET /health/integrations failed: ${res.status}`);
  }
  return (await res.json()) as IntegrationsHealth;
}

/** A short, human latency string (e.g. "103 ms"); '—' when none was measured. */
export function latencyLabel(ms: number | null): string {
  if (ms == null) return '—';
  return `${ms} ms`;
}
