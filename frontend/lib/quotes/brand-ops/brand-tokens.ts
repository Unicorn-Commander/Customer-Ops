/**
 * Brand tokens → the quote document's CSS variables. PURE (no Nest, no I/O).
 *
 * The considered default is "Ledger": unbleached paper, near-black ink, a
 * verdigris accent, sienna for "proposed". It is what renders when Brand-Ops is
 * unconfigured, unreachable, or a brand defines little. A brand colours the
 * document — it never replaces the paper: `brand/primary` becomes the accent
 * (pushed to ≥ 4.5:1 against the paper in each mode), `brand/accent` the
 * secondary highlight, and `surface/background` + `text/foreground` colour the
 * band blocks only when they contrast with each other. Type tokens are mapped
 * too (font/display, font/body, font/mono), prepended to the default stacks so
 * a brand that names a face we cannot load still degrades to something good.
 */

import { BrandTokens, QuotePalette, QuoteTheme, QuoteTypeTokens } from './brand-ops.types';

// ---------------------------------------------------------------------------
// The default — "Ledger"
// ---------------------------------------------------------------------------

export const DEFAULT_LIGHT: QuotePalette = {
  paper: '#f4f1ea',
  surface: '#fbf9f4',
  ink: '#1a1815',
  muted: '#6a655b',
  rule: '#d9d3c5',
  ruleStrong: '#1a1815',
  accent: '#1f6f6a',
  accentInk: '#175b57',
  accentSoft: 'rgba(31, 111, 106, 0.10)',
  accent2: '#a4561f',
  proposed: '#a4561f',
  ok: '#1f6f6a',
  danger: '#a13a2a',
  band: '#1b1a17',
  bandText: '#f4f1ea',
};

export const DEFAULT_DARK: QuotePalette = {
  paper: '#131211',
  surface: '#1c1a17',
  ink: '#ece7db',
  muted: '#a49e92',
  rule: '#35322c',
  ruleStrong: '#ece7db',
  accent: '#4fb8b0',
  accentInk: '#7fd0c9',
  accentSoft: 'rgba(79, 184, 176, 0.14)',
  accent2: '#e0895a',
  proposed: '#e0895a',
  ok: '#4fb8b0',
  danger: '#e07a6a',
  band: '#23211d',
  bandText: '#ece7db',
};

/** Default faces: a display serif with a voice, a humanist sans for running
 *  text, a mono for figures and labels. Never Inter, never Space Grotesk. */
export const DEFAULT_FAMILIES = {
  display: 'Instrument Serif',
  body: 'Instrument Sans',
  mono: 'JetBrains Mono',
} as const;

const FALLBACK = {
  display: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  body: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  mono: 'Menlo, Consolas, "Liberation Mono", monospace',
} as const;

export const DEFAULT_TYPE: QuoteTypeTokens = {
  display: `"${DEFAULT_FAMILIES.display}", ${FALLBACK.display}`,
  body: `"${DEFAULT_FAMILIES.body}", ${FALLBACK.body}`,
  mono: `"${DEFAULT_FAMILIES.mono}", ${FALLBACK.mono}`,
  webFamilies: [DEFAULT_FAMILIES.display, DEFAULT_FAMILIES.body, DEFAULT_FAMILIES.mono],
};

export const DEFAULT_THEME: QuoteTheme = {
  brand: null,
  branded: false,
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
  type: DEFAULT_TYPE,
  applied: [],
};

// ---------------------------------------------------------------------------
// Colour maths (sRGB, WCAG 2.x contrast)
// ---------------------------------------------------------------------------

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return 1;
  const la = luminance(ra);
  const lb = luminance(rb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix `color` toward `target` by `t` (0..1). */
function mix(color: [number, number, number], target: [number, number, number], t: number): [number, number, number] {
  return [color[0] + (target[0] - color[0]) * t, color[1] + (target[1] - color[1]) * t, color[2] + (target[2] - color[2]) * t];
}

/**
 * Push `color` toward black (on light paper) or white (on dark paper) in small
 * steps until it reads at `min` contrast against `paper`. Keeps the hue; only
 * the lightness moves. Returns the input unchanged when it already passes.
 */
export function ensureReadable(color: string, paper: string, min = 4.5): string {
  const rgb = parseHex(color);
  const bg = parseHex(paper);
  if (!rgb || !bg) return color;
  if (contrastRatio(color, paper) >= min) return toHex(rgb);
  const towardDark = luminance(bg) > 0.5;
  const target: [number, number, number] = towardDark ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.05; t <= 1; t += 0.05) {
    const candidate = toHex(mix(rgb, target, t));
    if (contrastRatio(candidate, paper) >= min) return candidate;
  }
  return toHex(target);
}

/** rgba() tint of a hex colour for soft backgrounds. */
export function tint(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${rgb.map(Math.round).join(', ')}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function tokenValue(tokens: BrandTokens, name: string): string | null {
  const hit = tokens.color.find((c) => c.name === name);
  return hit && parseHex(hit.value) ? toHex(parseHex(hit.value) as [number, number, number]) : null;
}

function familyValue(tokens: BrandTokens, name: string): string | null {
  const hit = tokens.typography?.find((t) => t.name === name);
  const v = hit?.value?.trim();
  return v && /^[A-Za-z0-9 .'&-]{2,60}$/.test(v) ? v : null;
}

/** A family the brand names that we do not already load. */
function extraFamily(v: string | null): string | null {
  if (!v) return null;
  const defaults = Object.values(DEFAULT_FAMILIES) as string[];
  return defaults.includes(v) ? null : v;
}

/** Generic-looking family names that should not be fetched from Google Fonts. */
const SYSTEM_FAMILIES = new Set(['Monaco', 'Menlo', 'Consolas', 'Courier', 'Courier New', 'Helvetica', 'Helvetica Neue', 'Arial', 'Georgia', 'Times', 'Times New Roman', 'system-ui', 'sans-serif', 'serif', 'monospace', 'SF Pro', 'SF Mono']);

/**
 * Resolve a theme from Brand-Ops tokens. `null` (unconfigured / unreachable /
 * unknown brand) yields the default theme, unchanged.
 */
export function resolveBrandTheme(tokens: BrandTokens | null, slug: string | null = tokens?.brand ?? null): QuoteTheme {
  if (!tokens) return { ...DEFAULT_THEME, brand: slug };
  const applied: string[] = [];
  const light: QuotePalette = { ...DEFAULT_LIGHT };
  const dark: QuotePalette = { ...DEFAULT_DARK };

  const primary = tokenValue(tokens, 'brand/primary');
  if (primary) {
    light.accent = ensureReadable(primary, light.paper);
    light.accentInk = ensureReadable(primary, light.paper, 5.5);
    light.accentSoft = tint(light.accent, 0.1);
    light.ok = light.accent;
    dark.accent = ensureReadable(primary, dark.paper);
    dark.accentInk = ensureReadable(primary, dark.paper, 5.5);
    dark.accentSoft = tint(dark.accent, 0.14);
    dark.ok = dark.accent;
    applied.push('brand/primary');
  }

  const accent2 = tokenValue(tokens, 'brand/accent');
  if (accent2) {
    light.accent2 = ensureReadable(accent2, light.paper);
    dark.accent2 = ensureReadable(accent2, dark.paper);
    applied.push('brand/accent');
  }

  const bg = tokenValue(tokens, 'surface/background');
  const fg = tokenValue(tokens, 'text/foreground');
  if (bg && fg && contrastRatio(bg, fg) >= 4.5) {
    light.band = bg;
    light.bandText = fg;
    dark.band = bg;
    dark.bandText = fg;
    applied.push('surface/background', 'text/foreground');
  }

  const display = familyValue(tokens, 'font/display');
  const body = familyValue(tokens, 'font/body');
  const mono = familyValue(tokens, 'font/mono');
  const type: QuoteTypeTokens = { ...DEFAULT_TYPE, webFamilies: [...DEFAULT_TYPE.webFamilies] };
  const addFamily = (fam: string | null, key: 'display' | 'body' | 'mono') => {
    if (!fam) return;
    type[key] = `"${fam}", ${DEFAULT_TYPE[key]}`;
    const extra = extraFamily(fam);
    if (extra && !SYSTEM_FAMILIES.has(extra) && !type.webFamilies.includes(extra)) type.webFamilies.push(extra);
    applied.push(`font/${key}`);
  };
  addFamily(display, 'display');
  addFamily(body, 'body');
  addFamily(mono, 'mono');

  return { brand: slug, branded: applied.length > 0, light, dark, type, applied };
}

// ---------------------------------------------------------------------------
// CSS emission
// ---------------------------------------------------------------------------

function paletteVars(p: QuotePalette): string {
  return [
    `--q-paper:${p.paper}`,
    `--q-surface:${p.surface}`,
    `--q-ink:${p.ink}`,
    `--q-muted:${p.muted}`,
    `--q-rule:${p.rule}`,
    `--q-rule-strong:${p.ruleStrong}`,
    `--q-accent:${p.accent}`,
    `--q-accent-ink:${p.accentInk}`,
    `--q-accent-soft:${p.accentSoft}`,
    `--q-accent-2:${p.accent2}`,
    `--q-proposed:${p.proposed}`,
    `--q-ok:${p.ok}`,
    `--q-danger:${p.danger}`,
    `--q-band:${p.band}`,
    `--q-band-text:${p.bandText}`,
  ].join(';');
}

/**
 * The three token blocks the document needs: light on bare :root, dark under
 * the guarded media query, dark again under the explicit attribute — plus the
 * type stacks. Print always uses the light palette (paper is paper).
 */
export function themeCss(theme: QuoteTheme): string {
  const type = `--q-font-display:${theme.type.display};--q-font-body:${theme.type.body};--q-font-mono:${theme.type.mono}`;
  return [
    `:root{${paletteVars(theme.light)};${type};color-scheme:light}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${paletteVars(theme.dark)};color-scheme:dark}}`,
    `:root[data-theme="dark"]{${paletteVars(theme.dark)};color-scheme:dark}`,
    `@media print{:root,:root[data-theme="dark"]{${paletteVars(theme.light)};color-scheme:light}}`,
  ].join('\n');
}

/** Google Fonts CSS2 URL for the theme's web families (null when none). */
export function fontStylesheetUrl(theme: QuoteTheme): string | null {
  const fams = theme.type.webFamilies;
  if (!fams.length) return null;
  const spec = (f: string) => {
    if (f === DEFAULT_FAMILIES.display) return 'family=Instrument+Serif:ital@0;1';
    if (f === DEFAULT_FAMILIES.body) return 'family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400';
    if (f === DEFAULT_FAMILIES.mono) return 'family=JetBrains+Mono:wght@400;500';
    return `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700`;
  };
  return `https://fonts.googleapis.com/css2?${fams.map(spec).join('&')}&display=swap`;
}
