import { contrastRatio, DEFAULT_THEME, ensureReadable, fontStylesheetUrl, resolveBrandTheme, themeCss } from './brand-tokens';

const magicUnicorn = {
  brand: 'magic-unicorn',
  color: [
    { name: 'brand/primary', value: '#b66eff' },
    { name: 'brand/accent', value: '#00d4ff' },
    { name: 'surface/background', value: '#0a0a0a' },
    { name: 'text/foreground', value: '#ffffff' },
    { name: 'text/muted', value: '#b3b3b3' },
  ],
  typography: [
    { name: 'font/display', value: 'Inter' },
    { name: 'font/body', value: 'Inter' },
    { name: 'font/mono', value: 'Monaco' },
  ],
};

describe('brand tokens → document theme', () => {
  it('the default is the considered "Ledger" palette, never Inter on black', () => {
    const t = resolveBrandTheme(null);
    expect(t.branded).toBe(false);
    expect(t.light.paper).toBe('#f4f1ea');
    expect(t.type.display).toMatch(/^"Instrument Serif"/);
    expect(t.type.body).not.toMatch(/Inter/);
    expect(contrastRatio(t.light.ink, t.light.paper)).toBeGreaterThan(12);
    expect(contrastRatio(t.light.accentInk, t.light.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.dark.accentInk, t.dark.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.light.proposed, t.light.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.dark.proposed, t.dark.paper)).toBeGreaterThanOrEqual(4.5);
  });

  it('maps a brand: primary → accent pushed to readable contrast in both modes, bg/fg → band, fonts → type', () => {
    const t = resolveBrandTheme(magicUnicorn);
    expect(t.branded).toBe(true);
    expect(t.applied).toEqual(expect.arrayContaining(['brand/primary', 'brand/accent', 'surface/background', 'text/foreground', 'font/display', 'font/body', 'font/mono']));
    // #b66eff fails on paper; it is darkened until it reads
    expect(t.light.accent).not.toBe('#b66eff');
    expect(contrastRatio(t.light.accent, t.light.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.dark.accent, t.dark.paper)).toBeGreaterThanOrEqual(4.5);
    // the paper stays paper — a brand colours the document, it does not replace it
    expect(t.light.paper).toBe(DEFAULT_THEME.light.paper);
    expect(t.light.band).toBe('#0a0a0a');
    expect(t.light.bandText).toBe('#ffffff');
    expect(t.type.display).toMatch(/^"Inter", "Instrument Serif"/);
    expect(t.type.mono).toMatch(/^"Monaco", "JetBrains Mono"/);
    expect(t.type.webFamilies).toContain('Inter');
    expect(t.type.webFamilies).not.toContain('Monaco');
  });

  it('ignores a brand band that does not contrast, and a brand with only colours keeps the default type', () => {
    const t = resolveBrandTheme({ brand: 'x', color: [{ name: 'surface/background', value: '#777777' }, { name: 'text/foreground', value: '#888888' }, { name: 'brand/primary', value: '#1f6f6a' }], typography: [] });
    expect(t.light.band).toBe(DEFAULT_THEME.light.band);
    expect(t.applied).toEqual(['brand/primary']);
    expect(t.type).toEqual(DEFAULT_THEME.type);
  });

  it('ensureReadable keeps a passing colour and fixes a failing one', () => {
    expect(ensureReadable('#1f6f6a', '#f4f1ea')).toBe('#1f6f6a');
    const fixed = ensureReadable('#ffff00', '#ffffff');
    expect(contrastRatio(fixed, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('emits light on :root, dark under the guarded media query and the attribute, print pinned to light', () => {
    const css = themeCss(resolveBrandTheme(null));
    expect(css).toMatch(/^:root\{--q-paper:#f4f1ea/);
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--q-paper:#131211');
    expect(css).toContain(':root[data-theme="dark"]{--q-paper:#131211');
    expect(css).toContain('@media print{:root,:root[data-theme="dark"]{--q-paper:#f4f1ea');
    expect(fontStylesheetUrl(resolveBrandTheme(null))).toContain('Instrument+Sans');
  });
});
