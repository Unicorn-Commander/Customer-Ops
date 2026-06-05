/**
 * Typed data layer for the Phase-6 lead-ingestion pipeline (the `ingest_lead`
 * keystone). Leadgen apps (Northwind, Magic Unicorn Outreach, LoopNet, multistate)
 * and agents push graduated leads at the backend's workspace-scoped intake
 * surface; this module mirrors that REST contract 1:1.
 *
 * Mirrors `lib/customers.ts`: the workspace id is resolved from the caller's
 * default membership (`resolveWorkspaceId`, re-exported here) and threaded into
 * every path as `/workspaces/:workspaceId/leads/*`. Customer-Ops never mints a
 * workspace id.
 *
 * Identity resolution is owned by the backend + Contact-Ops: an intake lands
 * PENDING, is matched to a Contact-Ops contact (RESOLVED), and is promoted to a
 * relationship. When Contact-Ops is dormant the intake is staged PROVISIONALLY
 * and upgraded later by `resolvePending`. The UI observes + nudges; it never
 * forges identity.
 */

import { apiGet, apiPost } from './api';
import { resolveWorkspaceId } from './customers';

export type { Priority } from './customers';
import type { Priority } from './customers';

/** Lifecycle of one ingested lead before it becomes a relationship. */
export type IntakeStatus = 'PENDING' | 'RESOLVED' | 'FAILED' | 'DISCARDED';

export const INTAKE_STATUSES: IntakeStatus[] = ['PENDING', 'RESOLVED', 'FAILED', 'DISCARDED'];
export const INTAKE_STATUS_LABEL: Record<IntakeStatus, string> = {
  PENDING: 'Pending',
  RESOLVED: 'Resolved',
  FAILED: 'Failed',
  DISCARDED: 'Discarded',
};

/**
 * One ingested lead. Mirrors the backend `LeadIntake` row. The dedup key
 * (`source` + `sourceDedupKey`) is the idempotency seam — a re-push of the same
 * key updates rather than duplicates. `provisional` flags a record staged while
 * Contact-Ops was dormant (resolved against a placeholder, upgraded later).
 */
export interface LeadIntake {
  id: string;
  source: string;
  sourceDedupKey: string;
  status: IntakeStatus;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  orgName: string | null;
  tags: string[];
  score: number | null;
  expectedValue: string | null;
  currency: string | null;
  priority: Priority;
  ownerUserKey: string | null;
  notes: string | null;
  resolvedContactId: string | null;
  provisional: boolean;
  customerId: string | null;
  statusDetail: string | null;
  createdByUcUid: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The intake KPIs (the header band). `coReachable` mirrors the live
 *  Contact-Ops health the backend observed on its last resolve attempt. */
export interface IntakeStats {
  total: number;
  byStatus: Record<IntakeStatus, number>;
  coReachable: boolean;
}

/** The body the leadgen apps / the manual form push (mirrors `IngestLeadDto`). */
export interface IngestLeadInput {
  source: string;
  sourceDedupKey: string;
  /** Explicit Contact-Ops contact id — resolves immediately when supplied. */
  contactId?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  orgName?: string;
  tags?: string[];
  score?: number;
  expectedValue?: string;
  currency?: string;
  priority?: Priority;
  ownerUserKey?: string;
  notes?: string;
  rawPayload?: Record<string, unknown>;
}

/** How the backend resolved (or failed to resolve) an ingest. */
export type ResolvedVia = 'explicit' | 'contact-ops' | 'provisional' | null;

/** The ingest result — the intake plus its resolution outcome. */
export interface IngestResult {
  intake: LeadIntake;
  resolved: boolean;
  via: ResolvedVia;
  provisional: boolean;
  contactId: string | null;
  customerId: string | null;
  detail: string;
}

/** The outcome of a resolve-pending sweep across the open queue. */
export interface ResolvePendingResult {
  scanned: number;
  resolved: number;
  stillOpen: number;
  provisionalUpgraded: number;
  coReachable: boolean;
}

/** A page of intakes (the table). */
export interface IntakePage {
  items: LeadIntake[];
  count: number;
}

/** Re-resolve the caller's active workspace id (default membership, else first). */
export { resolveWorkspaceId };

function base(ws: string): string {
  return `/workspaces/${encodeURIComponent(ws)}/leads`;
}

/** The ingestion KPIs + live Contact-Ops reachability. */
export async function getIntakeStats(ws: string): Promise<IntakeStats> {
  return apiGet<IntakeStats>(`${base(ws)}/stats`);
}

/** List intakes, optionally filtered by status / source, with a page window. */
export async function listIntakes(
  ws: string,
  opts: { status?: IntakeStatus; source?: string; limit?: number; offset?: number } = {},
): Promise<IntakePage> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.source) params.set('source', opts.source);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiGet<IntakePage>(`${base(ws)}/intakes${qs}`);
}

/** Fetch a single intake (the row drill-in). */
export async function getIntake(ws: string, id: string): Promise<LeadIntake> {
  return apiGet<LeadIntake>(`${base(ws)}/intakes/${encodeURIComponent(id)}`);
}

/** Push a lead into the pipeline (the manual ingest + the connector front door). */
export async function ingestLead(ws: string, body: IngestLeadInput): Promise<IngestResult> {
  return apiPost<IngestResult>(`${base(ws)}/ingest`, body);
}

/** Sweep the open queue, re-attempting identity resolution against Contact-Ops. */
export async function resolvePending(
  ws: string,
  opts: { limit?: number; scope?: 'pending' | 'pending_and_failed' } = {},
): Promise<ResolvePendingResult> {
  const body: { limit?: number; scope?: 'pending' | 'pending_and_failed' } = {};
  if (opts.limit !== undefined) body.limit = opts.limit;
  if (opts.scope !== undefined) body.scope = opts.scope;
  return apiPost<ResolvePendingResult>(`${base(ws)}/resolve-pending`, body);
}

/** Discard an open intake (spam / dupe / dead lead). Resolved rows can't be discarded. */
export async function discardIntake(
  ws: string,
  id: string,
  opts: { reason?: string } = {},
): Promise<LeadIntake> {
  return apiPost<LeadIntake>(`${base(ws)}/intakes/${encodeURIComponent(id)}/discard`, {
    reason: opts.reason,
  });
}

/* ── view helpers (pure; shared by the live + preview screens) ─────────────── */

/** Visual meta for one intake source. The known leadgen channels each get a
 *  distinct gradient + label; anything else falls back to a neutral chip. The
 *  gradient strings are written in FULL so Tailwind's scanner keeps them. */
export interface SourceMeta {
  label: string;
  gradient: string;
  /** Tinted chip text + well for the table's source pill. */
  text: string;
  well: string;
}

const SOURCE_META: Record<string, SourceMeta> = {
  northwind: { label: 'Northwind', gradient: 'from-rose-400 to-orange-500', text: 'text-rose-300', well: 'bg-rose-500/12' },
  'magic-unicorn-outreach': { label: 'Magic Unicorn Outreach', gradient: 'from-fuchsia-500 to-pink-500', text: 'text-fuchsia-300', well: 'bg-fuchsia-500/12' },
  outreach: { label: 'Magic Unicorn Outreach', gradient: 'from-fuchsia-500 to-pink-500', text: 'text-fuchsia-300', well: 'bg-fuchsia-500/12' },
  loopnet: { label: 'LoopNet', gradient: 'from-amber-400 to-orange-500', text: 'text-amber-300', well: 'bg-amber-500/12' },
  multistate: { label: 'multistate', gradient: 'from-cyan-400 to-blue-500', text: 'text-cyan-300', well: 'bg-cyan-500/12' },
  manual: { label: 'manual', gradient: 'from-violet-500 to-fuchsia-500', text: 'text-violet-300', well: 'bg-violet-500/12' },
  agent: { label: 'agent', gradient: 'from-emerald-400 to-teal-500', text: 'text-emerald-300', well: 'bg-emerald-500/12' },
};

const SOURCE_FALLBACK: SourceMeta = {
  label: 'other',
  gradient: 'from-slate-500 to-slate-600',
  text: 'text-tertiary',
  well: 'bg-surface-overlay',
};

/** Resolve a source key to its visual meta (case/format tolerant). Unknown
 *  sources keep their raw label on a neutral chip. */
export function sourceMeta(source: string | null): SourceMeta {
  if (!source) return SOURCE_FALLBACK;
  const key = source.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const hit = SOURCE_META[key];
  if (hit) return hit;
  return { ...SOURCE_FALLBACK, label: source };
}

/** The canonical leadgen sources, ordered for the breakdown strip. */
export const KNOWN_SOURCES = [
  'northwind',
  'magic-unicorn-outreach',
  'loopnet',
  'multistate',
  'manual',
  'agent',
] as const;

/** One source's tally for the breakdown strip. */
export interface SourceTally {
  source: string;
  meta: SourceMeta;
  count: number;
}

/** Group an intake list into per-source tallies, known sources first (in their
 *  canonical order), then any others by descending count. */
export function tallyBySource(intakes: LeadIntake[]): SourceTally[] {
  const counts = new Map<string, number>();
  for (const it of intakes) {
    const key = (it.source ?? 'other').trim().toLowerCase().replace(/[\s_]+/g, '-');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const out: SourceTally[] = [];
  for (const key of KNOWN_SOURCES) {
    seen.add(key);
    out.push({ source: key, meta: sourceMeta(key), count: counts.get(key) ?? 0 });
  }
  const extras: SourceTally[] = [];
  for (const [key, count] of counts) {
    if (seen.has(key)) continue;
    extras.push({ source: key, meta: sourceMeta(key), count });
  }
  extras.sort((a, b) => b.count - a.count);
  return [...out, ...extras];
}

/** Build a URL-safe dedup-key slug from an email (or any string). Mirrors the
 *  backend's suggestion so the operator sees the same default it would derive. */
export function slugifyDedupKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Compact relative time, past + future ("3d ago" / "in 5d"). */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = t - Date.now();
  const past = diff < 0;
  const s = Math.abs(diff) / 1000;
  const fmt = (n: number, unit: string) => (past ? `${n}${unit} ago` : `in ${n}${unit}`);
  if (s < 45) return past ? 'just now' : 'soon';
  if (s < 3600) return fmt(Math.round(s / 60), 'm');
  if (s < 86400) return fmt(Math.round(s / 3600), 'h');
  const d = Math.round(s / 86400);
  if (d === 1) return past ? 'yesterday' : 'tomorrow';
  if (d < 30) return fmt(d, 'd');
  if (d < 365) return fmt(Math.round(d / 30), 'mo');
  return fmt(Math.round(d / 365), 'y');
}

/** Absolute timestamp for a title tooltip. */
export function absoluteTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
