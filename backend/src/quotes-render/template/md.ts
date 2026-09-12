/**
 * A deliberately small Markdown renderer for quote prose. Supports what a
 * proposal needs and nothing that can carry a payload: paragraphs, `###`
 * headings, bullet and numbered lists, pipe tables, **bold**, *em*, `code`,
 * and http(s)/mailto links. Everything is HTML-escaped first; raw HTML in the
 * source renders as text. Output is wrapped in the caller's prose container.
 */

import { esc } from './html';

function inline(text: string): string {
  let out = esc(text);
  // code spans first so their contents are left alone
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  // Links in ONE pass, so the scheme decision is made once and no half-matched
  // URL can survive. The target allows a single level of nested parentheses —
  // `alert(1)` and Wikipedia-style `(disambiguation)` URLs both end at the
  // right bracket. A scheme we do not trust keeps its LABEL and loses its URL
  // entirely, so `javascript:` or `data:` never reaches the document at all:
  // not as an href, and not as visible text a reader might copy.
  out = out.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))*)\)/g, (_m, label: string, url: string) =>
    /^(?:https?:\/\/|mailto:)/i.test(url) ? `<a href="${url}" rel="noopener noreferrer">${label}</a>` : label,
  );
  return out;
}

function table(rows: string[]): string {
  const cells = (line: string) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const th = head.map((h, i) => `<th${i === head.length - 1 && head.length > 1 ? ' class="q-md-last"' : ''}>${inline(h)}</th>`).join('');
  const trs = body.map((r) => `<tr>${head.map((_, i) => `<td${i === head.length - 1 && head.length > 1 ? ' class="q-md-last"' : ''}>${inline(r[i] ?? '')}</td>`).join('')}</tr>`).join('');
  return `<div class="q-tablewrap"><table class="q-md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

export function renderMarkdown(src: string | null | undefined, opts: { proseOnly?: boolean } = {}): string {
  if (!src || !src.trim()) return '';
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const isTableSep = (l: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // heading
    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h && !opts.proseOnly) {
      const level = Math.min(4, h[1].length + 1); // ## → h3, ### → h4 inside a section
      out.push(`<h${level} class="q-h${level}">${inline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }
    // table
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1]) && !opts.proseOnly) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      out.push(table(rows));
      continue;
    }
    // lists
    const ul = /^\s*[-*]\s+/.test(line);
    const ol = /^\s*\d+[.)]\s+/.test(line);
    if ((ul || ol) && !opts.proseOnly) {
      const tag = ul ? 'ul' : 'ol';
      const re = ul ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, '');
        i++;
        // continuation lines (indented, non-list)
        while (i < lines.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !re.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item.trim())}</li>`);
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    // paragraph (until blank or block start)
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !(/^(#{2,4})\s+/.test(lines[i]) && !opts.proseOnly) && !((/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i])) && !opts.proseOnly)) {
      buf.push(lines[i].trim());
      i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}
