import { orderPadRecord } from './fixtures/orderpad.fixture';
import { internalStrings, toQuoteView, toStudioOverlay } from './quote-view';
import { renderQuoteDocument, renderQuoteDocumentParts } from './template/document';
import { renderMarkdown } from './template/md';
import { resolveBrandTheme } from '../brand-ops/brand-tokens';

const theme = resolveBrandTheme(null);
const links = { acceptUrl: '/q/fx/accept', confirmUrl: '/q/fx/accept/confirm', pdfUrl: '/q/fx/pdf' };

function openView() {
  return toQuoteView(orderPadRecord(), { state: 'open', version: { no: 2, disposition: 'current' }, now: '2026-09-12T20:00:00Z' });
}

describe('renderQuoteDocument — the one template', () => {
  it('never leaks internal notes, basis, split, costs or recipient addresses in the client render or the PDF body', () => {
    const record = orderPadRecord();
    const view = toQuoteView(record, { state: 'open', now: '2026-09-12T20:00:00Z' });
    const web = renderQuoteDocument(view, { mode: 'web', theme, ...links });
    const print = renderQuoteDocument(view, { mode: 'print', theme, acceptUrl: null, confirmUrl: null, pdfUrl: null });
    const secrets = internalStrings(record);
    expect(secrets.length).toBeGreaterThan(5);
    for (const s of secrets) {
      const needle = s.slice(0, 40);
      expect(web).not.toContain(needle);
      expect(print).not.toContain(needle);
    }
    expect(web).not.toMatch(/50\/50|percent_net|rackboy1|jordan\.mercer@/);
    // The `.q-band` RULE is always in the inlined stylesheet (one stylesheet for
    // every mode); what must never appear in a client render is the band ELEMENT.
    expect(web).not.toContain('<div class="q-band"');
    expect(print).not.toContain('<div class="q-band"');
  });

  it('renders the studio overlay only when asked, with the basis notes in the margin', () => {
    const record = orderPadRecord();
    const view = toQuoteView(record, { state: 'open' });
    const studio = renderQuoteDocument(view, { mode: 'web', theme, acceptUrl: null, confirmUrl: null, pdfUrl: null, preview: 'studio', studio: toStudioOverlay(record) });
    expect(studio).toContain('Studio · basis');
    expect(studio).toContain('cut their cycle in half');
    expect(studio).toContain('q-band');
    expect(studio).toContain('jordan.mercer@example.com');
    expect(studio).toContain('Studio preview');
    // the client preview of the same record has none of it
    const client = renderQuoteDocument(view, { mode: 'web', theme, acceptUrl: null, confirmUrl: null, pdfUrl: null, preview: 'client' });
    expect(client).not.toContain('cut their cycle in half');
    expect(client).toContain('Client preview');
  });

  it('carries the letterhead, the folio, the lede as prose, the tax line and the data-driven matrix', () => {
    const html = renderQuoteDocument(openView(), { mode: 'web', theme, ...links });
    expect(html).toContain('Brightwater Labs LLC');
    expect(html).toContain('Charlotte, NC 28202');
    expect(html).toContain('class="q-folio"');
    expect(html).toContain('Q-2026-0001');
    expect(html).toContain('Valid until');
    expect(html).toContain('12 October 2026');
    expect(html).toContain('class="q-lede"');
    expect(html).not.toMatch(/class="q-lede"><ul/);
    expect((html.match(/Amounts exclude tax; tax is applied on the invoice\./g) ?? []).length).toBeGreaterThanOrEqual(2);
    // matrix: one column per package, rows from the features, the "no package" alternative below
    expect(html).toContain('class="q-matrix"');
    expect((html.match(/class="q-opt(?: is-selected)?" data-opt-id=/g) ?? []).length).toBe(3);
    expect(html).toContain('Break-fix response');
    expect(html).toContain('Four business hours');
    expect(html).toContain('q-opt-alt');
    expect(html).toContain('Hosting and operations alone');
    // the selected package is marked and the year-one figure is live
    expect(html).toMatch(/class="q-opt is-selected" data-opt-id="l-pkg-improve"/);
    expect(html).toContain('data-fig="year_one">$62,800');
    expect(html).toContain('with Improve it');
  });

  it('shows agreed/proposed pills, the ruled milestone table with a kept totals row, included and excluded lists', () => {
    const html = renderQuoteDocument(openView(), { mode: 'web', theme, ...links });
    expect(html).toContain('class="q-pill agreed"');
    expect(html).toContain('class="q-pill proposed"');
    expect(html).toContain('<tbody class="q-keep">');
    expect(html).toContain('$36,000');
    expect(html).toContain('18 wks');
    expect(html).toContain('Included, at no extra charge');
    expect(html).toContain('Not in this quote');
    expect(html).toContain('Card numbers on file');
  });

  it('renders the acceptance form + code step when open, and the sticky bar for phones', () => {
    const html = renderQuoteDocument(openView(), { mode: 'web', theme, ...links });
    expect(html).toContain('id="q-accept-form"');
    expect(html).toContain('action="/q/fx/accept"');
    expect(html).toContain('id="q-code-form"');
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain('I accept quote Q-2026-0001 on behalf of The apparel client');
    expect(html).toContain('class="q-sticky q-no-print"');
    expect(html).toContain('data-fig="deposit">$23,000');
    expect(html).toContain('<script>');
  });

  it('renders superseded read-only with a banner and no form, and expired with its state', () => {
    const sup = toQuoteView(orderPadRecord(), { state: 'superseded', state_at: '2026-09-12T18:30:00Z', version: { no: 1, disposition: 'superseded' } });
    const html = renderQuoteDocument(sup, { mode: 'web', theme, ...links });
    expect(html).toContain('Superseded');
    expect(html).toContain('ask Brightwater Labs for the current quote');
    expect(html).not.toContain('id="q-accept-form"');
    expect(html).toContain('Acceptance closed');
    expect(html).toContain('no-cta');
    expect(html).toMatch(/<input type="radio"[^>]* disabled>/);
    const exp = toQuoteView(orderPadRecord(), { state: 'expired', state_at: '2026-08-01' });
    const eh = renderQuoteDocument(exp, { mode: 'web', theme, ...links });
    expect(eh).toContain('Expired');
    expect(eh).not.toContain('id="q-accept-form"');
  });

  it('renders the receipt state with what happens next, the typed signature and the PDF link', () => {
    const acc = toQuoteView(orderPadRecord(), { state: 'accepted', state_at: '2026-09-12T19:41:00Z', accepted_by: { name: 'Jordan Mercer', email: 'jordan.mercer@example.com', title: 'Operations lead', ip: '203.0.113.7', ua: 'x' } });
    const html = renderQuoteDocument(acc, { mode: 'web', theme, ...links });
    expect(html).toContain('What happens next');
    expect(html).toContain('class="q-receipt"');
    expect(html).toContain('Jordan Mercer');
    expect(html).toContain('Download the PDF receipt');
    expect(html).toContain('$23,000');
    expect(html).not.toContain('203.0.113.7');
    expect(html).not.toContain('jordan.mercer@example.com');
    const recorded = toQuoteView(orderPadRecord(), { state: 'accepted', state_at: '2026-09-12T20:05:00Z', accepted_by: { name: 'Jordan Mercer', email: 'j@example.com', title: null, recorded_by_member: 'Aaron Stransky' } });
    expect(renderQuoteDocument(recorded, { mode: 'web', theme, ...links })).toContain('Recorded by Aaron Stransky on behalf of Jordan Mercer');
  });

  it('print mode: light theme pinned, no script, no sticky, signature block, page size honoured', () => {
    const letter = renderQuoteDocument(openView(), { mode: 'print', pageSize: 'letter', theme, acceptUrl: null, confirmUrl: null, pdfUrl: null });
    expect(letter).toContain('data-theme="light"');
    expect(letter).not.toContain('<script>');
    expect(letter).not.toContain('class="q-sticky');
    expect(letter).toContain('q-sig-print');
    expect(letter).toContain('@page{size:Letter');
    const a4 = renderQuoteDocument(openView(), { mode: 'print', pageSize: 'a4', theme, acceptUrl: null, confirmUrl: null, pdfUrl: null });
    expect(a4).toContain('@page{size:A4');
  });

  it('emits both theme blocks and the type tokens, and escapes user text', () => {
    const view = openView();
    view.title = '<img src=x onerror=alert(1)> & "quotes"';
    const html = renderQuoteDocument(view, { mode: 'web', theme, ...links });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
    expect(html).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain('--q-font-display:"Instrument Serif"');
    expect(html).toContain('fonts.googleapis.com/css2?family=Instrument+Serif');
  });
});

describe('renderMarkdown', () => {
  it('handles paragraphs, headings, lists, tables, inline marks and escapes html', () => {
    const html = renderMarkdown('Intro **bold** *em* `code`\n\n### Head\n\n- one\n- two <b>x</b>\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n1. first\n2. second\n\n[site](https://example.com) [bad](javascript:alert(1))');
    expect(html).toContain('<p>Intro <strong>bold</strong> <em>em</em> <code>code</code></p>');
    expect(html).toContain('<h4 class="q-h4">Head</h4>');
    expect(html).toContain('<ul><li>one</li><li>two &lt;b&gt;x&lt;/b&gt;</li></ul>');
    expect(html).toContain('<table class="q-md-table">');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<a href="https://example.com" rel="noopener noreferrer">site</a>');
    expect(html).not.toContain('javascript:');
  });
  it('prose-only mode keeps lists as text', () => {
    expect(renderMarkdown('- not a list\n\npara', { proseOnly: true })).not.toContain('<ul>');
  });
});

describe('one template, two hosts', () => {
  it('renderQuoteDocumentParts composes back into exactly renderQuoteDocument', () => {
    const view = openView();
    const opts = { mode: 'web' as const, theme, ...links };
    const whole = renderQuoteDocument(view, opts);
    const parts = renderQuoteDocumentParts(view, opts);
    // The Next.js share route renders the parts into its own document shell.
    // If these ever diverge, the page and the PDF are two designs, not one.
    expect(whole).toContain(parts.html);
    expect(whole).toContain(parts.css);
    expect(whole).toContain(`<title>${parts.title.replace(/&/g, '&amp;')}</title>`);
    expect(whole).toContain(`<script>${parts.script}</script>`);
    expect(parts.forceLightTheme).toBe(false);
  });

  it('the print parts carry no script and pin the light palette', () => {
    const parts = renderQuoteDocumentParts(openView(), { mode: 'print', theme, acceptUrl: null, confirmUrl: null, pdfUrl: null });
    expect(parts.script).toBe('');
    expect(parts.forceLightTheme).toBe(true);
    expect(parts.html).not.toContain('q-toolbar');
    expect(parts.html).not.toContain('q-sticky');
  });

  it('every viewport media query is scoped to screen so paper never inherits the phone layout', () => {
    const css = renderQuoteDocumentParts(openView(), { mode: 'print', theme, acceptUrl: null, confirmUrl: null, pdfUrl: null }).css;
    const viewportQueries = css.match(/@media[^{]*max-width[^{]*\{/g) ?? [];
    expect(viewportQueries.length).toBeGreaterThan(0);
    for (const q of viewportQueries) expect(q).toContain('screen');
  });

  it('page size reaches the @page rule for both Letter and A4', () => {
    const base = { mode: 'print' as const, theme, acceptUrl: null, confirmUrl: null, pdfUrl: null };
    expect(renderQuoteDocumentParts(openView(), { ...base, pageSize: 'letter' }).css).toContain('@page{size:Letter');
    expect(renderQuoteDocumentParts(openView(), { ...base, pageSize: 'a4' }).css).toContain('@page{size:A4');
  });
});

describe('document details that have bitten', () => {
  it('a terms-list row carries exactly one child — the marker is the ::before cell', () => {
    const html = renderQuoteDocument(openView(), { mode: 'web', theme, ...links });
    const rows = html.match(/<ul class="q-terms-list[^"]*">.*?<\/ul>/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    // Two children in a 20px/1fr grid pushed the text into the 20px column.
    expect(html).not.toContain('<li><span></span><span>');
  });

  it('offers the reader both themes on the web and neither control in print', () => {
    const web = renderQuoteDocument(openView(), { mode: 'web', theme, ...links });
    expect(web).toContain('data-theme-set="auto"');
    expect(web).toContain('data-theme-set="light"');
    expect(web).toContain('data-theme-set="dark"');
    const print = renderQuoteDocument(openView(), { mode: 'print', theme, acceptUrl: null, confirmUrl: null, pdfUrl: null });
    expect(print).not.toContain('data-theme-set');
  });

  it('keeps the last money row and the totals row in one unbreakable block', () => {
    const html = renderQuoteDocument(openView(), { mode: 'print', theme, acceptUrl: null, confirmUrl: null, pdfUrl: null });
    expect(html).toMatch(/<tbody class="q-keep">.*?q-total.*?<\/tbody>/s);
    expect(html).toContain('tbody.q-keep{break-inside:avoid');
  });

  it('drops a link whose scheme is not http(s) or mailto, label and all', () => {
    const html = renderMarkdown('see [here](javascript:alert(1)) and [there](data:text/html,x)');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:');
    expect(html).toContain('see here and there');
  });
});

describe('the live total the reader actually sees (M1)', () => {
  it('carries each option line\'s OWN deposit, so the browser never redoes a split', () => {
    const html = renderQuoteDocument(openView(), { mode: 'web', theme, ...links });
    // The old attribute was the raw first percentage, which nothing read.
    expect(html).not.toContain('data-split=');
    const deposits = [...html.matchAll(/data-deposit="(\d+)"/g)].map((m) => Number(m[1]));
    expect(deposits.length).toBeGreaterThanOrEqual(4);
    // Recurring packages do not schedule a deposit; the numbers are computeQuote's.
    expect(deposits.every((d) => Number.isInteger(d))).toBe(true);
  });

  it('starts the script from the non-option deposit and repaints [data-fig=deposit]', () => {
    const html = renderQuoteDocument(openView(), { mode: 'web', theme, ...links });
    const cfg = JSON.parse((html.match(/data-q="([^"]*)"/) ?? [])[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
    const view = openView();
    const nonOption = view.sections
      .flatMap((s) => s.lines)
      .filter((l) => !l.option_group)
      .reduce((sum, l) => sum + l.deposit_cents, 0);
    expect(cfg.base.deposit).toBe(nonOption);
    // Base + the selected package's own deposit must equal the server's total.
    const selected = view.sections.flatMap((s) => s.lines).filter((l) => l.option_group && l.selected);
    expect(cfg.base.deposit + selected.reduce((s, l) => s + l.deposit_cents, 0)).toBe(view.totals.deposit_cents);
    expect(html).toContain('data-fig="deposit"');
    expect(html).toContain("setText('[data-fig=deposit]',money(t.deposit))");
  });
});

describe('the package headline stacks (H4)', () => {
  it('gives the three option spans their own lines', () => {
    const css = renderQuoteDocumentParts(openView(), { mode: 'web', theme, ...links }).css;
    // They are <span>s: without display:block they ignore margin-top and run
    // together as "Keep it running$600PER MONTH".
    expect(css).toMatch(/\.q-opt-name\{display:block/);
    expect(css).toMatch(/\.q-opt-price\{display:block/);
    expect(css).toMatch(/\.q-opt-per\{display:block/);
    expect(css).toContain('.q-opt-card .q-opt-name,.q-opt-card .q-opt-price,.q-opt-card .q-opt-per{display:block}');
  });
});

describe('show_delivery_partner gates the partner on the client\'s paper', () => {
  it('names the partner by default and drops the phrase when the flag is off', () => {
    const eyebrow = (html: string) => (html.match(/class="q-label q-eyebrow">([^<]*)</) ?? [])[1] ?? '';

    const on = renderQuoteDocument(openView(), { mode: 'web', theme, ...links });
    expect(eyebrow(on)).toBe('Proposal · Brightwater Labs with Magic Unicorn Unconventional Technology &amp; Stuff Inc');

    const record = orderPadRecord();
    record.quote.show_delivery_partner = false;
    const off = renderQuoteDocument(toQuoteView(record, { state: 'open', now: '2026-09-12T20:00:00Z' }), { mode: 'web', theme, ...links });
    expect(eyebrow(off)).toBe('Proposal · Brightwater Labs');
    // The lede is the drafter's prose and is NOT rewritten by the flag — the
    // flag gates the masthead attribution, not the words someone chose.
    expect(off).toContain('with Magic Unicorn as platform partner');
    // The split is unaffected — it never leaves the workspace either way.
    expect(toStudioOverlay(record).split_rule.percent).toBe(50);
  });
});
