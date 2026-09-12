/**
 * Brand-Ops federation types — the wire shape of `get_brand_tokens(slug)` and
 * the resolved theme the quote renderer consumes.
 */

/** One semantic colour token as Brand-Ops returns it. */
export interface BrandColorToken {
  /** e.g. "brand/primary", "brand/accent", "surface/background", "text/foreground", "text/muted" */
  name: string;
  /** "#rrggbb" */
  value: string;
  rgb?: [number, number, number];
}

export interface BrandTypographyToken {
  /** "font/display" | "font/body" | "font/mono" */
  name: string;
  /** A family name, e.g. "Fraunces". */
  value: string;
}

/** The raw `get_brand_tokens` result. Only colours a brand defines are present. */
export interface BrandTokens {
  brand: string;
  color: BrandColorToken[];
  typography: BrandTypographyToken[];
  css?: string;
}

/** The document palette: every `--q-*` colour the template uses. */
export interface QuotePalette {
  paper: string;
  surface: string;
  ink: string;
  muted: string;
  rule: string;
  ruleStrong: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  accent2: string;
  proposed: string;
  ok: string;
  danger: string;
  band: string;
  bandText: string;
}

export interface QuoteTypeTokens {
  /** Full CSS font-family stacks (quoted where needed). */
  display: string;
  body: string;
  mono: string;
  /** Families to fetch from Google Fonts (empty = nothing to load). */
  webFamilies: string[];
}

/** The resolved theme handed to the renderer: both modes + type. */
export interface QuoteTheme {
  /** The brand slug the theme was resolved for, or null for the house default. */
  brand: string | null;
  /** True when a brand was found and contributed at least one token. */
  branded: boolean;
  light: QuotePalette;
  dark: QuotePalette;
  type: QuoteTypeTokens;
  /** What was taken from the brand — for the studio "brand" badge + tests. */
  applied: string[];
}
