/**
 * renderQuoteDocument — ONE template for the public share page, the studio
 * preview and the PDF. Pure string rendering from a QuoteView (client-safe by
 * type) plus an optional StudioOverlay that only the member preview passes.
 *
 * Structure: letterhead → masthead (eyebrow, title, lede prose, state stamp) →
 * ledger strip (live totals) → numbered sections (prose, ruled line tables,
 * the data-driven option matrix, included/excluded lists) → acceptance (form,
 * code step, receipt, or the paper signature block in print) → footer →
 * sticky mobile call-to-action. Internal material renders ONLY inside the
 * studio overlay (margin asides + the band at the end).
 */

import { formatMoney, intervalSuffix, type RecurringInterval } from '../quote-model';
import type { QuoteView, QuoteViewLine, QuoteViewSection, StudioOverlay } from '../quote-view';
import { fontStylesheetUrl, themeCss } from '../../brand-ops/brand-tokens';
import type { QuoteTheme } from '../../brand-ops/brand-ops.types';
import { esc, escAttrJson, join, longDate, longDateTime } from './html';
import { renderMarkdown } from './md';
import { DOCUMENT_CSS } from './styles';
import { DOCUMENT_SCRIPT } from './script';

export type PageSize = 'letter' | 'a4';

export interface RenderOptions {
  /** web = interactive share page / preview; print = the PDF body. */
  mode: 'web' | 'print';
  pageSize?: PageSize;
  theme: QuoteTheme;
  /** Where the acceptance form posts (null → no live acceptance, e.g. preview). */
  acceptUrl: string | null;
  confirmUrl: string | null;
  /** The PDF link shown in the toolbar / receipt (null → hidden). */
  pdfUrl: string | null;
  /**
   * Where the document asks for its A10 binding cookie, once, on load. Only the
   * Next.js share route sets this: its server render cannot set a cookie, so the
   * browser fetches the binding itself. The backend-served document mints the
   * cookie on its own GET and leaves this null.
   */
  bindUrl?: string | null;
  /** Studio material — ONLY the member preview passes this. */
  studio?: StudioOverlay | null;
  /** Preview: the form is rendered disabled and labelled. */
  preview?: 'client' | 'studio' | null;
}

const TAX_LINE = 'Amounts exclude tax; tax is applied on the invoice.';

function money(cents: number, currency: string): string {
  return formatMoney(cents, currency);
}

function pill(tag: QuoteViewLine['status_tag']): string {
  return `<span class="q-pill ${tag}">${tag}</span>`;
}

function amountCell(l: QuoteViewLine, currency: string): string {
  if (l.money_kind === 'hourly') {
    const rate = l.hourly?.rate_cents ?? l.unit_price_cents;
    return `${money(rate, currency)}<small>/hr</small>`;
  }
  if (l.money_kind === 'recurring') return `${money(l.amount_cents, currency)}<small>${intervalSuffix(l.recurring?.interval ?? 'month')}</small>`;
  if (l.money_kind === 'included') return 'Included';
  if (l.money_kind === 'excluded') return '—';
  return money(l.amount_cents, currency);
}

function dimCell(l: QuoteViewLine): string {
  if (l.money_kind === 'milestone' && l.milestone?.weeks) return `${l.milestone.weeks} wks`;
  if (l.money_kind === 'hourly' && l.hourly?.minimum_hours) return `${l.hourly.minimum_hours} h min`;
  if (l.money_kind === 'recurring' && l.recurring?.notice_days) return `${l.recurring.notice_days}-day notice`;
  if (l.qty !== 1 && l.unit) return `${l.qty} × ${esc(l.unit)}`;
  return '';
}

function discountNote(l: QuoteViewLine, currency: string): string {
  if (!l.discount_cents) return '';
  const pct = l.gross_cents ? Math.round((l.discount_cents / l.gross_cents) * 1000) / 10 : 0;
  return `<span class="q-line-disc">less ${pct ? `${pct}%` : 'discount'} (${money(-l.discount_cents, currency)}) from ${money(l.gross_cents, currency)}</span>`;
}

function lineRow(l: QuoteViewLine, currency: string, showDim: boolean): string {
  return `<tr><td><span class="q-line-label">${esc(l.label)}</span>${pill(l.status_tag)}${discountNote(l, currency)}${l.description_md ? `<div class="q-line-desc">${renderMarkdown(l.description_md)}</div>` : ''}</td>${showDim ? `<td class="q-dim">${dimCell(l)}</td>` : ''}<td class="q-amt">${amountCell(l, currency)}</td></tr>`;
}

/** The ruled table for the money lines of one section (no options). */
function linesTable(lines: QuoteViewLine[], currency: string): string {
  if (!lines.length) return '';
  const showDim = lines.some((l) => dimCell(l));
  const summable = lines.filter((l) => l.money_kind === 'one_time' || l.money_kind === 'milestone');
  const total = summable.reduce((s, l) => s + l.amount_cents, 0);
  const weeks = summable.reduce((s, l) => s + (l.milestone?.weeks ?? 0), 0);
  const hasTotal = summable.length >= 2;
  const head = `<thead><tr><th>Line</th>${showDim ? `<th class="q-dim">${summable.some((l) => l.milestone?.weeks) ? 'Weeks' : ''}</th>` : ''}<th class="q-amt">Amount</th></tr></thead>`;
  if (!hasTotal) return `<table class="q-lines">${head}<tbody>${lines.map((l) => lineRow(l, currency, showDim)).join('')}</tbody></table>`;
  // Keep the last data row and the totals row together so print never orphans a total.
  const body = lines.slice(0, -1).map((l) => lineRow(l, currency, showDim)).join('');
  const last = lineRow(lines[lines.length - 1], currency, showDim);
  const totalRow = `<tr class="q-total"><td>Total</td>${showDim ? `<td class="q-dim">${weeks ? `${weeks} wks` : ''}</td>` : ''}<td class="q-amt">${money(total, currency)}</td></tr>`;
  return `<table class="q-lines">${head}<tbody>${body}</tbody><tbody class="q-keep">${last}${totalRow}</tbody></table>`;
}

function termsList(lines: QuoteViewLine[], heading: string, excluded: boolean): string {
  if (!lines.length) return '';
  return `<h3 class="q-h3">${esc(heading)}</h3><ul class="q-terms-list${excluded ? ' is-excluded' : ''}">${lines
    // The marker is the ::before pseudo-element, which occupies the first grid
    // cell; the row carries exactly ONE child so the text lands in the wide one.
    .map((l) => `<li><span><span class="q-line-label">${esc(l.label)}</span>${l.description_md ? `<div class="q-line-desc">${renderMarkdown(l.description_md)}</div>` : ''}</span></li>`)
    .join('')}</ul>`;
}

function optInput(l: QuoteViewLine, group: { key: string; mode: string }, disabled: boolean): string {
  const type = group.mode === 'additive' ? 'checkbox' : 'radio';
  return `<input type="${type}" name="og-${esc(group.key)}" value="${esc(l.id)}" data-opt data-label="${esc(l.label)}" data-amount="${l.amount_cents}" data-kind="${l.money_kind}" data-interval="${l.recurring?.interval ?? ''}" data-split="${l.milestone?.payment_split?.[0] ?? 50}"${l.selected ? ' checked' : ''}${disabled ? ' disabled' : ''}>`;
}

/** The data-driven package matrix for one option group (+ its feature-less alternatives). */
function optionGroup(view: QuoteView, group: QuoteView['option_groups'][number], lines: QuoteViewLine[], disabled: boolean): string {
  const currency = view.currency;
  const columns = lines.filter((l) => l.features && l.features.length);
  const alts = lines.filter((l) => !l.features || !l.features.length);
  const rows: string[] = [];
  for (const c of columns) for (const f of c.features ?? []) if (!rows.includes(f.label)) rows.push(f.label);
  const per = (l: QuoteViewLine) => (l.money_kind === 'recurring' ? `per ${l.recurring?.interval ?? 'month'}` : l.money_kind === 'milestone' ? 'milestone' : 'one-time');
  const choose = group.mode === 'additive' ? 'Add' : 'Choose';
  const head = columns
    .map(
      (l) => `<th><label class="q-opt${l.selected ? ' is-selected' : ''}" data-opt-id="${esc(l.id)}"><span class="q-opt-tag">Selected</span><span class="q-opt-name">${esc(l.label)}</span><span class="q-opt-price">${money(l.amount_cents, currency)}</span><span class="q-opt-per">${per(l)}${pill(l.status_tag)}</span><span class="q-opt-ctl">${optInput(l, group, disabled)} ${choose}</span></label></th>`,
    )
    .join('');
  const body = rows
    .map((r) => `<tr><td>${esc(r)}</td>${columns.map((c) => `<td data-opt-id="${esc(c.id)}"${c.selected ? ' class="is-selected"' : ''}>${esc(c.features?.find((f) => f.label === r)?.value ?? '—')}</td>`).join('')}</tr>`)
    .join('');
  const matrix = columns.length
    ? `<table class="q-matrix"><thead><tr><th><span class="q-sr">Package</span></th>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '';
  const cards = columns.length
    ? `<div class="q-opt-cards">${columns
        .map(
          (l) => `<label class="q-opt-card${l.selected ? ' is-selected' : ''}" data-opt-id="${esc(l.id)}"><span class="q-opt-tag">Selected</span><span class="q-opt-name">${esc(l.label)}</span><span class="q-opt-price">${money(l.amount_cents, currency)}</span><span class="q-opt-per">${per(l)}${pill(l.status_tag)}</span><dl>${(l.features ?? []).map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl><span class="q-opt-ctl">${optInput(l, group, disabled)} ${choose}</span></label>`,
        )
        .join('')}</div>`
    : '';
  const altRows = alts
    .map(
      (l) => `<label class="q-opt-alt${l.selected ? ' is-selected' : ''}" data-opt-id="${esc(l.id)}"><span class="q-opt-ctl">${optInput(l, group, disabled)}</span><span class="q-opt-alt-name">${esc(l.label)}${pill(l.status_tag)}</span><span class="q-opt-alt-desc">${esc(l.description_md ?? '')}</span><span class="q-opt-alt-price">${money(l.amount_cents, currency)}<small>${l.money_kind === 'recurring' ? intervalSuffix(l.recurring?.interval ?? 'month') : ''}</small></span></label>`,
    )
    .join('');
  const note = group.mode === 'additive' ? 'Add any that fit; the totals above follow your choice.' : 'Choose one; the totals above follow your choice.';
  return `<div class="q-options" role="group" aria-label="${esc(group.label)}">${group.intro_md ? `<div class="q-options-intro q-prose">${renderMarkdown(group.intro_md)}</div>` : ''}${matrix}${cards}${altRows}${disabled ? '' : `<p class="q-select-note">${note}</p>`}</div>`;
}

function section(view: QuoteView, s: QuoteViewSection, studio: StudioOverlay | null | undefined, disabled: boolean): string {
  const currency = view.currency;
  const money_lines = s.lines.filter((l) => !l.option_group && (l.money_kind === 'one_time' || l.money_kind === 'milestone' || l.money_kind === 'recurring'));
  const hourly = s.lines.filter((l) => !l.option_group && l.money_kind === 'hourly');
  const included = s.lines.filter((l) => l.money_kind === 'included');
  const excluded = s.lines.filter((l) => l.money_kind === 'excluded');
  const groupsHere = view.option_groups.filter((g) => s.lines.some((l) => l.option_group === g.key));
  const tags = new Set(s.lines.filter((l) => l.money_kind !== 'included' && l.money_kind !== 'excluded').map((l) => l.status_tag));
  const headPill = tags.size === 1 ? pill([...tags][0]) : '';
  const basis = studio?.basis_by_section[s.id];
  return `<section class="q-section" id="s-${s.no}"><div class="q-section-no" aria-hidden="true">${String(s.no).padStart(2, '0')}</div><div class="q-section-main"><div class="q-section-head"><span class="q-label">Section ${s.no}</span><h2 class="q-h2">${esc(s.heading)}${headPill}</h2></div>${s.body_md ? `<div class="q-body-md q-prose">${renderMarkdown(s.body_md)}</div>` : ''}${linesTable(money_lines, currency)}${groupsHere.map((g) => optionGroup(view, g, s.lines.filter((l) => l.option_group === g.key), disabled)).join('')}${hourly.length ? `<h3 class="q-h3">Outside a package</h3>${linesTable(hourly, currency)}` : ''}${termsList(included, 'Included, at no extra charge', false)}${termsList(excluded, 'Not in this quote', true)}</div>${basis ? `<aside class="q-aside"><span class="q-label">Studio · basis</span>${renderMarkdown(basis)}</aside>` : ''}</section>`;
}

function ledger(view: QuoteView): string {
  const t = view.totals;
  const c = view.currency;
  const oneTime = view.sections.flatMap((s) => s.lines).filter((l) => l.money_kind === 'one_time' && !l.option_group);
  const milestones = view.sections.flatMap((s) => s.lines).filter((l) => l.money_kind === 'milestone' && !l.option_group);
  const weeks = milestones.reduce((s, l) => s + (l.milestone?.weeks ?? 0), 0);
  const selected = view.sections.flatMap((s) => s.lines).filter((l) => l.option_group && l.selected);
  const selNote = selected.length ? `with ${selected.map((l) => l.label).join(', ')}` : 'no package selected';
  return `<div class="q-ledger" aria-label="Totals"><div><span class="q-label">One-time</span><div class="q-fig q-num" data-fig="one_time">${money(t.one_time_cents, c)}</div><div class="q-fig-note">${oneTime.length ? esc(oneTime.map((l) => l.label).join(' · ')) : '—'}</div></div><div><span class="q-label">Milestones</span><div class="q-fig q-num" data-fig="milestone">${money(t.milestone_cents, c)}</div><div class="q-fig-note">${milestones.length ? `${milestones.length} milestone${milestones.length === 1 ? '' : 's'}${weeks ? ` · ${weeks} weeks` : ''}` : '—'}</div></div><div><span class="q-label">Monthly</span><div class="q-fig q-num" data-fig="monthly">${money(t.recurring.monthly_equivalent_cents, c)}<small>/mo</small></div><div class="q-fig-note" data-fig-note="selection">${esc(selNote)}</div></div><div><span class="q-label">Year one, illustrated</span><div class="q-fig q-num q-live" data-fig="year_one">${money(t.year_one_cents, c)}</div><div class="q-fig-note">one-time + milestones + twelve months</div></div></div><p class="q-tax">${TAX_LINE}${view.tax_estimate_cents !== null ? ` Estimated tax: ${money(view.tax_estimate_cents, c)} (estimate only).` : ''}</p>`;
}

function stateNotice(view: QuoteView): string {
  const a = view.acceptance;
  const when = a.state_at ? ` on ${longDate(a.state_at)}` : '';
  const vendor = esc(view.vendor.label);
  switch (a.state) {
    case 'superseded':
      return `<div class="q-notice" role="status"><strong>Superseded</strong><span>This is version ${view.version.no}, replaced${when}. It is kept for reference and cannot be accepted — ask ${vendor} for the current quote.</span></div>`;
    case 'expired':
      return `<div class="q-notice is-muted" role="status"><strong>Expired</strong><span>This quote was valid until ${longDate(view.valid_until)}. Ask ${vendor} for a fresh version; nothing here can be accepted now.</span></div>`;
    case 'revoked':
      return `<div class="q-notice is-muted" role="status"><strong>Withdrawn</strong><span>This link is no longer active${when}. Ask ${vendor} for a current one.</span></div>`;
    case 'declined':
      return `<div class="q-notice is-muted" role="status"><strong>Declined</strong><span>This quote was declined${when}.${a.state_note ? ` ${esc(a.state_note)}` : ''}</span></div>`;
    case 'voided':
      return `<div class="q-notice is-muted" role="status"><strong>Voided</strong><span>This quote was voided${when} and no longer stands.</span></div>`;
    case 'accepted':
      return `<div class="q-notice is-ok" role="status"><strong>Accepted</strong><span>Accepted${a.accepted_by ? ` by ${esc(a.accepted_by.name)}` : ''}${a.accepted_at ? ` on ${longDate(a.accepted_at)}` : ''}. The receipt is at the end of this document.</span></div>`;
    default:
      return '';
  }
}

function stamp(view: QuoteView): string {
  const s = view.acceptance.state;
  if (s === 'accepted') return `<span class="q-stamp is-ok">Accepted</span>`;
  if (s === 'superseded') return `<span class="q-stamp">Superseded</span>`;
  if (s === 'expired' || s === 'revoked' || s === 'voided' || s === 'declined') return `<span class="q-stamp is-muted">${s === 'revoked' ? 'Withdrawn' : s}</span>`;
  if (s === 'draft') return `<span class="q-stamp is-muted">Draft</span>`;
  return '';
}

function acceptanceSummary(view: QuoteView, live: boolean): string {
  const c = view.currency;
  const all = view.sections.flatMap((s) => s.lines);
  const fixed = all.filter((l) => !l.option_group && (l.money_kind === 'one_time' || l.money_kind === 'milestone'));
  const hourly = all.filter((l) => !l.option_group && l.money_kind === 'hourly');
  const recurringFixed = all.filter((l) => !l.option_group && l.money_kind === 'recurring');
  const selected = all.filter((l) => l.option_group && l.selected);
  const sub = (l: QuoteViewLine) => `<span class="q-sub">${l.money_kind === 'milestone' ? 'milestone · half on start, half on acceptance' : l.money_kind === 'one_time' ? 'one-time · half on signature, half on acceptance' : ''} ${l.status_tag}</span>`;
  const staticRows = [...fixed, ...recurringFixed]
    .map((l) => `<li><span>${esc(l.label)}${sub(l)}</span><span>${amountCell(l, c)}</span></li>`)
    .concat(hourly.map((l) => `<li><span>${esc(l.label)}<span class="q-sub">outside a package · ${l.hourly?.minimum_hours ? `${l.hourly.minimum_hours}-hour minimum` : 'by the hour'}</span></span><span>${amountCell(l, c)}</span></li>`))
    .join('');
  const optRows = selected.map((l) => `<li><span>${esc(l.label)}</span><span>${amountCell(l, c)}</span></li>`).join('');
  const t = view.totals;
  return `<ul class="q-accept-summary">${staticRows}</ul><ul class="q-accept-summary" ${live ? 'data-opt-summary' : ''}>${optRows}</ul><ul class="q-accept-summary"><li class="q-total"><span>Due on acceptance<span class="q-sub">the first part of each one-time line and milestone</span></span><span data-fig="deposit">${money(t.deposit_cents, c)}</span></li><li class="q-total"><span>Year one, illustrated</span><span data-fig="year_one">${money(t.year_one_cents, c)}</span></li></ul><p class="q-tax">${TAX_LINE}</p>`;
}

function whatHappensNext(view: QuoteView): string {
  const c = view.currency;
  const all = view.sections.flatMap((s) => s.lines);
  const first = all.find((l) => !l.option_group && (l.money_kind === 'one_time' || l.money_kind === 'milestone'));
  const selected = all.filter((l) => l.option_group && l.selected && l.money_kind === 'recurring');
  const name = view.acceptance.accepted_by?.name ?? 'you';
  const steps = [
    `A copy of this receipt goes to ${esc(name)} by email.`,
    `${esc(view.vendor.label)} issues the invoice due on acceptance, ${money(view.totals.deposit_cents, c)}: the first part of each one-time line and milestone. ${TAX_LINE}`,
    first ? `Work on “${esc(first.label)}” starts on the agreed date; each milestone has a written acceptance test, walked through together and signed.` : `Work starts on the agreed date.`,
  ];
  if (selected.length) steps.push(`${esc(selected.map((l) => l.label).join(' and '))} begins at go-live, billed ${selected[0].recurring?.interval === 'month' ? 'monthly' : selected[0].recurring?.interval === 'quarter' ? 'quarterly' : 'yearly'} in advance.`);
  return `<h3 class="q-h3">What happens next</h3><ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol>`;
}

function acceptanceBlock(view: QuoteView, opts: RenderOptions): string {
  const a = view.acceptance;
  const who = view.customer.org_name ?? view.customer.display_name;
  const print = opts.mode === 'print';
  const live = a.can_accept && !print;
  const summary = acceptanceSummary(view, live);
  const sigPrint = `<div class="q-sig q-sig-print" aria-label="Signature block"><div><div class="q-sig-line"></div><span class="q-label">Signature · for ${esc(who)}</span></div><div><div class="q-sig-line"></div><span class="q-label">Date</span></div><div><div class="q-sig-line"></div><span class="q-label">Name</span></div><div><div class="q-sig-line"></div><span class="q-label">Title</span></div></div>`;

  if (a.state === 'accepted') {
    const by = a.accepted_by;
    const how = by?.recorded_by_member ? `Recorded by ${esc(by.recorded_by_member)} on behalf of ${esc(by.name)}.` : 'Confirmed by the six-digit code emailed to the acceptor.';
    return `<section class="q-accept" id="accept"><div><span class="q-label">Acceptance</span><h2 class="q-h2">Accepted for ${esc(who)}</h2>${summary}${whatHappensNext(view)}</div><div class="q-receipt"><span class="q-stamp is-ok">Accepted</span><div class="q-receipt-title">${esc(by?.name ?? 'Accepted')}</div><div class="q-receipt-meta">${by?.title ? `${esc(by.title)}, ` : ''}${esc(who)}${a.accepted_at ? `<br>${longDateTime(a.accepted_at)}` : ''}<br>${how}</div><div class="q-sig q-receipt-by"><div><div class="q-sig-line"><span class="q-sig-name">${esc(by?.name ?? '')}</span></div><span class="q-label">Signature (typed)</span></div><div><div class="q-sig-line"><span class="q-num" style="font-size:14px">${a.accepted_at ? longDate(a.accepted_at) : ''}</span></div><span class="q-label">Date</span></div></div><div class="q-label">Quote ${esc(view.number)} · version ${view.version.no}</div>${opts.pdfUrl && !print ? `<div class="q-btn-row"><a class="q-btn is-secondary" href="${esc(opts.pdfUrl)}">Download the PDF receipt</a></div>` : ''}</div></section>`;
  }

  if (!a.can_accept) {
    const reason = a.state === 'superseded' ? 'This version cannot be accepted; ask for the current quote.' : a.state === 'expired' ? 'This quote has expired.' : a.state === 'draft' ? 'This is a draft; nothing renders publicly until it is sent.' : 'Acceptance is closed for this version.';
    return `<section class="q-accept" id="accept"><div><span class="q-label">Acceptance</span><h2 class="q-h2">What accepting would cover</h2>${summary}</div><div class="q-form" aria-disabled="true"><div class="q-form-title">Acceptance closed</div><p class="q-form-sub">${reason}</p></div></section>`;
  }

  if (print) {
    return `<section class="q-accept" id="accept"><div><span class="q-label">Acceptance</span><h2 class="q-h2">Accepting this quote</h2><p class="q-prose">Sign below, or accept online from the link in the covering email; either way each milestone has its own written acceptance test.</p>${summary}</div><div>${sigPrint}</div></section>`;
  }

  const disabled = opts.preview ? ' disabled' : '';
  const previewNote = opts.preview ? `<p class="q-form-sub"><strong>Preview.</strong> Acceptance is disabled until the quote is sent.</p>` : '';
  const gate = a.recipients_gate ? ' Use the email address the quote was sent to.' : '';
  return `<section class="q-accept" id="accept"><div><span class="q-label">Acceptance</span><h2 class="q-h2">Accepting this quote</h2><p class="q-prose">By accepting, ${esc(who)} agrees to the lines below at the prices shown, on the terms in this document. A six-digit code goes to your email to confirm it was you; the receipt follows at once.</p>${summary}</div><div><form class="q-form" id="q-accept-form" method="post" action="${esc(opts.acceptUrl ?? '#')}" novalidate><fieldset${disabled}><div class="q-form-title">Accept ${esc(view.number)}</div>${previewNote}<p class="q-form-sub">Your name, work email and title.${gate}</p><div class="q-field"><label class="q-label" for="q-name">Name</label><input type="text" id="q-name" name="name" autocomplete="name" required></div><div class="q-field"><label class="q-label" for="q-email">Email</label><input type="email" id="q-email" name="email" autocomplete="email" inputmode="email" required></div><div class="q-field"><label class="q-label" for="q-title">Title</label><input type="text" id="q-title" name="title" autocomplete="organization-title" placeholder="Operations lead"></div><label class="q-check"><input type="checkbox" name="accepted" value="1" required><span>I accept quote ${esc(view.number)} on behalf of ${esc(who)}.</span></label><input type="hidden" name="selected_line_ids" data-opt-hidden value=""><p class="q-form-err" id="q-accept-err" role="alert" aria-live="polite"></p><button class="q-btn" type="submit">Accept ${esc(view.number)}</button><noscript><p class="q-noscript">Turn on JavaScript to accept online, or sign the PDF.</p></noscript></fieldset></form><div class="q-form q-code" id="q-code" hidden><form id="q-code-form" novalidate><div class="q-form-title">Check your email</div><p class="q-form-sub" id="q-code-hint">We sent a six-digit code to your address. It is good for ten minutes.</p><div class="q-field"><label class="q-label" for="q-code-input">Six-digit code</label><input class="q-code-input" id="q-code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div><p class="q-form-err" id="q-code-err" role="alert" aria-live="polite"></p><div class="q-btn-row"><button class="q-btn" type="submit">Confirm acceptance</button><button class="q-btn is-secondary" type="button" id="q-code-again" hidden>Start again</button></div></form><p class="q-form-sub" id="q-code-done" hidden><strong>Confirmed.</strong> Preparing your receipt…</p></div></div></section>`;
}

function studioBand(view: QuoteView, s: StudioOverlay): string {
  const c = view.currency;
  const costTotal = s.costs.reduce((a, x) => a + x.amount_cents, 0);
  const split = s.split_rule;
  const splitText = split.kind === 'none' ? 'No partner split.' : split.kind === 'fee' ? `Fee${split.percent ? ` · ${split.percent}%` : ''}.` : `${split.percent ?? '?'}% of net after direct costs${split.hosting_to_partner ? '; hosting to the partner in full' : ''}.`;
  const fed = s.federated;
  return `<div class="q-band" aria-label="Studio only"><span class="q-label">Studio · internal · never leaves the workspace</span><h2 class="q-h2">The split, direct costs, recipients and notes</h2><div class="q-band-grid"><div><h3 class="q-h3">Split</h3><dl class="q-kv"><dt>Vendor of record</dt><dd>${esc(view.vendor.label)}</dd><dt>Delivery partner</dt><dd>${esc(view.delivery_partner?.label ?? '—')}</dd><dt>Rule</dt><dd>${esc(splitText)}</dd>${split.notes ? `<dt>Notes</dt><dd>${esc(split.notes)}</dd>` : ''}</dl></div><div><h3 class="q-h3">Direct costs</h3><table><thead><tr><th>Cost</th><th>Kind</th><th class="q-amt">Amount</th></tr></thead><tbody>${s.costs.map((x) => `<tr><td>${esc(x.label)}${x.notes ? `<div class="q-line-desc">${esc(x.notes)}</div>` : ''}</td><td>${esc(x.kind.replace('_', ' '))}</td><td class="q-amt">${money(x.amount_cents, c)}</td></tr>`).join('') || '<tr><td colspan="3">None recorded.</td></tr>'}</tbody></table><p class="q-label" style="margin-top:8px">Total ${money(costTotal, c)} · only the total reaches the partner adapter</p></div><div><h3 class="q-h3">Recipients</h3>${s.recipients.length ? `<dl class="q-kv">${s.recipients.map((r) => `<dt>${esc(r.role)}</dt><dd>${esc(r.name)} · ${esc(r.email)}</dd>`).join('')}</dl><p class="q-line-desc" style="margin-top:8px">Only these addresses may accept.</p>` : '<p>No named recipients — any address may accept.</p>'}</div><div><h3 class="q-h3">Federation</h3>${fed ? `<dl class="q-kv"><dt>Status</dt><dd>${esc(fed.status)}</dd><dt>Project-Ops</dt><dd>${esc(fed.cursors.project_ops)}</dd><dt>Accounting-Ops</dt><dd>${esc(fed.cursors.accounting_ops)}</dd><dt>Partner</dt><dd>${esc(fed.cursors.partner)}</dd>${fed.last_error ? `<dt>Last error</dt><dd>${esc(fed.last_error)}</dd>` : ''}</dl>` : '<p>Not accepted yet.</p>'}</div></div>${s.internal_notes_md ? `<h3 class="q-h3">Internal notes</h3><div class="q-prose">${renderMarkdown(s.internal_notes_md)}</div>` : ''}</div>`;
}

/**
 * The document in pieces, so a host that already owns `<html>` (the Next.js
 * share route) can server-render the SAME markup the PDF prints without a
 * second template. `renderQuoteDocument` is these parts in a standalone shell.
 */
export interface DocumentParts {
  /** `<title>` text. */
  title: string;
  /** Google Fonts stylesheet URL for the theme's faces (null when none). */
  fontStylesheet: string | null;
  /** Theme variables + the document stylesheet + the @page rule, in that order. */
  css: string;
  /** The single `.q-doc` element: ribbon, page, sticky call-to-action. */
  html: string;
  /** The progressive-enhancement script, or '' in print mode. */
  script: string;
  /** Theme-attribute hint: print pins the light palette. */
  forceLightTheme: boolean;
}

export function renderQuoteDocumentParts(view: QuoteView, opts: RenderOptions): DocumentParts {
  const print = opts.mode === 'print';
  const currency = view.currency;
  const t = view.totals;
  const all = view.sections.flatMap((s) => s.lines);
  const base = all
    .filter((l) => !l.option_group)
    .reduce(
      (acc, l) => {
        if (l.money_kind === 'one_time') acc.one_time += l.amount_cents;
        else if (l.money_kind === 'milestone') acc.milestone += l.amount_cents;
        else if (l.money_kind === 'recurring') acc[(l.recurring?.interval ?? 'month') as RecurringInterval] += l.amount_cents;
        return acc;
      },
      { one_time: 0, milestone: 0, month: 0, quarter: 0, year: 0 },
    );
  const symbol = formatMoney(0, currency).replace(/0$/, '');
  const cfg = { base, symbol, accept_url: opts.acceptUrl, confirm_url: opts.confirmUrl, bind_url: opts.bindUrl ?? null, no_selection_note: 'no package selected', sticky_empty: 'Choose a package' };
  const disabledOptions = !view.acceptance.can_accept || !!opts.preview;
  const noCta = !view.acceptance.can_accept || !!opts.preview || print;
  const classes = join(['q-doc', opts.studio ? 'has-studio' : null, noCta ? 'no-cta' : null], ' ');
  const fontLink = fontStylesheetUrl(opts.theme);
  const pageSize = opts.pageSize === 'a4' ? 'A4' : 'Letter';
  const selected = all.filter((l) => l.option_group && l.selected);

  const ribbon = opts.preview === 'studio' ? `<div class="q-studio-ribbon">Studio preview · internal notes visible · not what the client sees</div>` : opts.preview === 'client' ? `<div class="q-studio-ribbon" style="background:var(--q-ink)">Client preview · exactly what the share link renders</div>` : '';

  // Both themes are designed on purpose, so the reader gets to choose one:
  // Auto follows the system, Light and Dark pin it. The choice is a per-reader
  // convenience (localStorage), never document state.
  const themeSwitch = `<div class="q-theme" role="group" aria-label="Colour theme"><button type="button" data-theme-set="auto" aria-pressed="true">Auto</button><button type="button" data-theme-set="light" aria-pressed="false">Light</button><button type="button" data-theme-set="dark" aria-pressed="false">Dark</button></div>`;
  const toolbar = print
    ? ''
    : `<nav class="q-toolbar q-no-print" aria-label="Document">${themeSwitch}<span class="q-toolbar-sep" aria-hidden="true"></span>${opts.pdfUrl ? `<a href="${esc(opts.pdfUrl)}">Download PDF</a>` : ''}<a href="#accept">Acceptance</a></nav>`;

  const letterhead = `<header class="q-letterhead"><div><div class="q-vendor-name">${esc(view.vendor.legal_name || view.vendor.label)}</div><div class="q-vendor-lines">${view.vendor.address_lines.map((l) => `<span>${esc(l)}</span>`).join('')}${view.vendor.tax_id ? `<span>${esc(view.vendor.tax_id_label ?? 'Tax ID')} ${esc(view.vendor.tax_id)}</span>` : ''}${join([view.vendor.email ? esc(view.vendor.email) : null, view.vendor.phone ? esc(view.vendor.phone) : null, view.vendor.website ? esc(view.vendor.website) : null], ' · ') ? `<span>${join([view.vendor.email ? esc(view.vendor.email) : null, view.vendor.phone ? esc(view.vendor.phone) : null, view.vendor.website ? esc(view.vendor.website) : null], ' · ')}</span>` : ''}</div></div><div><div class="q-folio" aria-label="Quote number">${esc(view.number)}</div><dl class="q-meta"><dt>Quote</dt><dd>${esc(view.number)} · v${view.version.no}</dd><dt>Date</dt><dd>${longDate(view.issued_on)}</dd><dt>Valid until</dt><dd>${longDate(view.valid_until)}</dd></dl></div></header>`;

  const masthead = `<div class="q-masthead"><div><div class="q-label q-eyebrow">Proposal · ${esc(view.vendor.label)}${view.delivery_partner ? ` with ${esc(view.delivery_partner.label)}` : ''}</div><h1 class="q-h1">${esc(view.title)}</h1>${view.lede_md ? `<div class="q-lede">${renderMarkdown(view.lede_md, { proseOnly: true })}</div>` : ''}</div><div class="q-masthead-side">${stamp(view)}<div class="q-prepared">Prepared for<strong>${esc(view.customer.org_name ?? view.customer.display_name)}</strong>${view.customer.attention ? `${esc(view.customer.attention)}` : ''}</div></div></div>`;

  const sections = view.sections.map((s) => section(view, s, opts.studio, disabledOptions)).join('');
  const terms = view.terms_md ? `<section class="q-section"><div class="q-section-no" aria-hidden="true">§</div><div class="q-section-main"><div class="q-section-head"><span class="q-label">Terms</span><h2 class="q-h2">Terms</h2></div><div class="q-body-md q-prose">${renderMarkdown(view.terms_md)}</div></div></section>` : '';

  const footer = `<footer class="q-footer"><span>${esc(view.vendor.label)} · Quote ${esc(view.number)} · version ${view.version.no} · issued ${longDate(view.issued_on)} · valid until ${longDate(view.valid_until)}</span><span>${TAX_LINE}</span></footer>`;

  const sticky = noCta
    ? ''
    : `<div class="q-sticky q-no-print" role="region" aria-label="Accept"><div class="q-sticky-main"><div class="q-sticky-sel" data-fig="sticky-sel">${esc(selected.map((l) => l.label).join(', ') || 'Choose a package')}</div><div class="q-sticky-total"><span data-fig="year_one">${money(t.year_one_cents, currency)}</span> <small>year one</small></div></div><a class="q-btn" href="#accept" data-cta>Accept</a></div>`;

  return {
    title: `${view.number} · ${view.title}`,
    fontStylesheet: fontLink,
    css: `${themeCss(opts.theme)}\n${DOCUMENT_CSS}\n@page{size:${pageSize};margin:18mm 16mm 20mm}`,
    html: `<div class="${classes}" data-q="${escAttrJson(cfg)}">${ribbon}<div class="q-page">${toolbar}${letterhead}${masthead}${stateNotice(view)}${ledger(view)}${sections}${terms}${acceptanceBlock(view, opts)}${opts.studio ? studioBand(view, opts.studio) : ''}${footer}</div>${sticky}</div>`,
    script: print ? '' : DOCUMENT_SCRIPT,
    forceLightTheme: print,
  };
}

/** The standalone document — the PDF body and the backend's own share route. */
export function renderQuoteDocument(view: QuoteView, opts: RenderOptions): string {
  const p = renderQuoteDocumentParts(view, opts);
  const fonts = p.fontStylesheet
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(p.fontStylesheet)}">`
    : '';
  const head = `<!doctype html><html lang="en"${p.forceLightTheme ? ' data-theme="light"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(p.title)}</title>${fonts}<style>${p.css}</style></head>`;
  return `${head}<body class="q-body">${p.html}${p.script ? `<script>${p.script}</script>` : ''}</body></html>`;
}
