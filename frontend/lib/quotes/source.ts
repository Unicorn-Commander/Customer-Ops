/**
 * Server-side source for the public share page.
 *
 * The page does NOT proxy markup. It asks Customer-Ops for the client-safe
 * `QuoteView` plus the resolved brand theme as DATA, then server-renders the
 * SAME template the PDF prints — the copy vendored under `lib/quotes/`
 * (byte-identical to the backend's, enforced by `mirror.spec.ts`). One
 * template, two runtimes, no second design.
 *
 * Acceptance still belongs to the backend: the POSTs go through the route
 * handlers in `app/q/[token]/accept`, which forward the binding cookie.
 *
 * FIXTURE MODE (`QUOTES_RENDER_FIXTURE=1`) renders the vendored Order Pad
 * fixture when the API is unset or unreachable, so the look can be reviewed
 * and screenshotted without a backend. It is opt-in on purpose: without the
 * flag an unreachable API is a 404, never a silently fabricated document.
 */

import { DEFAULT_THEME, resolveBrandTheme } from './brand-ops/brand-tokens';
import type { QuoteTheme } from './brand-ops/brand-ops.types';
import { orderPadRecord, FIXTURE_TOKEN_CURRENT, FIXTURE_TOKEN_SUPERSEDED } from './quotes-render/fixtures/orderpad.fixture';
import { toQuoteView, type AcceptanceState, type QuoteView } from './quotes-render/quote-view';

export interface ResolvedQuote {
  view: QuoteView;
  theme: QuoteTheme;
  /** True when the document came from the vendored fixture, not the API. */
  fixture: boolean;
}

/** Absolute base URL of the Customer-Ops API as seen from the Next server. */
export function apiBase(): string | null {
  const explicit = process.env.QUOTES_RENDER_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const shared = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (shared && /^https?:\/\//.test(shared)) return shared.replace(/\/$/, '');
  return null;
}

export function fixtureEnabled(): boolean {
  return process.env.QUOTES_RENDER_FIXTURE === '1';
}

const TOKEN_RE = /^[A-Za-z0-9_-]{4,128}$/;

/** Which fixture state a token stands for (the backend's FixtureQuoteSource map). */
const FIXTURE_STATES: Record<string, AcceptanceState> = {
  [FIXTURE_TOKEN_CURRENT]: 'open',
  [FIXTURE_TOKEN_SUPERSEDED]: 'superseded',
  'fx-orderpad-expired': 'expired',
  'fx-orderpad-accepted': 'accepted',
  'fx-orderpad-recorded': 'accepted',
  'fx-orderpad-revoked': 'revoked',
  'fx-orderpad-declined': 'declined',
};

function fromFixture(token: string): ResolvedQuote | null {
  const state = FIXTURE_STATES[token];
  if (!state) return null;
  const record = orderPadRecord();
  const superseded = state === 'superseded';
  const recorded = token === 'fx-orderpad-recorded';
  const view = toQuoteView(record, {
    state,
    version: { no: superseded ? 1 : 2, disposition: superseded ? 'superseded' : state === 'accepted' ? 'accepted' : 'current' },
    state_at: state === 'open' ? null : '2026-09-12T19:20:00Z',
    state_note: state === 'declined' ? 'The client is holding the roadmap until after the show freeze.' : null,
    accepted_by:
      state === 'accepted'
        ? {
            name: 'Jordan Mercer',
            email: 'jordan.mercer@example.com',
            title: 'Operations lead',
            recorded_by_member: recorded ? 'Aaron Stransky' : null,
          }
        : null,
    now: '2026-09-12T20:00:00Z',
  });
  return { view, theme: resolveBrandTheme(null, view.brand_slug), fixture: true };
}

/**
 * Resolve a share token. Asks the API first (which records the view and mints
 * the binding cookie); falls back to the vendored fixture only in fixture mode.
 * Returns the `Set-Cookie` the API issued so the route can pass it on.
 */
export async function resolveQuote(
  token: string,
  headers: { cookie?: string; ip?: string; ua?: string } = {},
): Promise<{ quote: ResolvedQuote | null; setCookie: string | null }> {
  if (!TOKEN_RE.test(token)) return { quote: null, setCookie: null };
  const base = apiBase();
  if (base) {
    try {
      const res = await fetch(`${base}/public/quotes/${encodeURIComponent(token)}/view`, {
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(headers.cookie ? { Cookie: headers.cookie } : {}),
          ...(headers.ua ? { 'User-Agent': headers.ua } : {}),
          ...(headers.ip ? { 'X-Forwarded-For': headers.ip } : {}),
        },
      });
      if (res.ok) {
        const body = (await res.json()) as { found: boolean; view: QuoteView; theme: QuoteTheme };
        if (body.found) {
          return { quote: { view: body.view, theme: body.theme ?? DEFAULT_THEME, fixture: false }, setCookie: res.headers.get('set-cookie') };
        }
      }
      // A clean 404 from the API is authoritative — do not paper over it.
      if (res.status === 404 && !fixtureEnabled()) return { quote: null, setCookie: null };
    } catch {
      // Transport failure: fall through to the fixture only when it is enabled.
    }
  }
  if (!fixtureEnabled()) return { quote: null, setCookie: null };
  return { quote: fromFixture(token), setCookie: null };
}
