/**
 * The composer — the studio side of a quote.
 *
 * Sections and their lines, option groups and the package matrix, the
 * price-book picker, internal notes and per-section basis margin notes, direct
 * costs (A3), the partner split, recipients (A1), validity and the brand.
 *
 * Everything internal is fenced into one visibly-marked region: the composer
 * says out loud which fields never leave the workspace, because the whole
 * contract turns on that (§2.6, §5, A3). The money strip is `computeQuote`
 * over the same lines the client document renders — never a second sum.
 */

'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Lock, Plus, Trash2 } from 'lucide-react';

import { Badge, Button, cn } from '@/components/ui';
import {
  addCost,
  addLine,
  addOptionGroup,
  addRecipient,
  addSection,
  blankLine,
  lineFromPriceBook,
  moveLine,
  moveSection,
  patchCost,
  patchLine,
  patchOptionGroup,
  patchQuote,
  patchRecipient,
  patchSection,
  removeCost,
  removeLine,
  removeOptionGroup,
  removeRecipient,
  removeSection,
  selectOption,
  PRICE_BOOK,
  type QuoteDraft,
} from '@/lib/quotes/draft';
import {
  formatMoney,
  paymentParts,
  type LineKind,
  type QuoteLine,
  type QuoteSection,
} from '@/lib/quotes/quotes-render/quote-model';

import { Field, MoneyInput, RowButton, Select, TextArea, TextInput } from './parts';

const LINE_KINDS: ReadonlyArray<{ value: LineKind; label: string }> = [
  { value: 'one_time', label: 'One-time' },
  { value: 'milestone', label: 'Milestone' },
  { value: 'recurring', label: 'Recurring' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'option', label: 'Option' },
  { value: 'included', label: 'Included' },
  { value: 'excluded', label: 'Excluded' },
];

const SECTION_KINDS: ReadonlyArray<{ value: QuoteSection['kind']; label: string }> = [
  { value: 'summary', label: 'Summary (the lede)' },
  { value: 'scope', label: 'Scope' },
  { value: 'acceptance', label: 'Acceptance' },
  { value: 'terms', label: 'Terms' },
  { value: 'custom', label: 'Custom' },
];

const BRANDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'No brand — the considered default (Ledger)' },
  { value: 'brightwater-labs', label: 'brightwater-labs' },
  { value: 'magic-unicorn', label: 'magic-unicorn' },
  { value: 'apparel-pad', label: 'apparel-pad' },
];

function Panel({
  title,
  eyebrow,
  internal,
  action,
  children,
}: {
  title: string;
  eyebrow?: string;
  internal?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-token-lg border bg-surface-raised shadow-token',
        internal ? 'border-warning/40' : 'border-subtle',
      )}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-subtle px-4 py-3">
        <div className="min-w-0 flex-1">
          {eyebrow ? <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-muted">{eyebrow}</span> : null}
          <h2 className="truncate text-[15px] font-semibold text-primary">{title}</h2>
        </div>
        {internal ? (
          <Badge variant="warning">
            <Lock className="mr-1 h-3 w-3" strokeWidth={2.4} />
            Never leaves the workspace
          </Badge>
        ) : null}
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function LineEditor({ draft, line }: { draft: QuoteDraft; line: QuoteLine }) {
  const { apply, record } = draft;
  const [open, setOpen] = useState(false);
  const groups = record.quote.option_groups;
  const set = (patch: Partial<QuoteLine>) => apply((r) => patchLine(r, line.id, patch));

  return (
    <div className="rounded-token border border-subtle bg-surface-overlay/50">
      <div className="flex flex-wrap items-start gap-2 p-2.5">
        <div className="min-w-[180px] flex-1">
          <TextInput value={line.label} onChange={(v) => set({ label: v })} placeholder="Line label" />
        </div>
        <Select className="w-[124px]" value={line.kind} onChange={(v) => set(kindPatch(v))} options={LINE_KINDS} />
        <Select
          className="w-[112px]"
          value={line.status_tag}
          onChange={(v) => set({ status_tag: v })}
          options={[
            { value: 'agreed', label: 'agreed' },
            { value: 'proposed', label: 'proposed' },
          ]}
        />
        <div className="w-[120px]">
          <MoneyInput cents={line.unit_price_cents} onCents={(c) => set({ unit_price_cents: c })} />
        </div>
        <div className="flex items-center gap-1.5">
          <RowButton onClick={() => setOpen((v) => !v)} label={open ? 'Collapse line' : 'Expand line'}>
            {open ? <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.4} /> : <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.4} />}
          </RowButton>
          <RowButton onClick={() => apply((r) => moveLine(r, line.id, -1))} label="Move line up">
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.4} />
          </RowButton>
          <RowButton onClick={() => apply((r) => moveLine(r, line.id, 1))} label="Move line down">
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.4} />
          </RowButton>
          <RowButton onClick={() => apply((r) => removeLine(r, line.id))} label="Remove line">
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2.4} />
          </RowButton>
        </div>
      </div>

      {open ? (
        <div className="grid gap-3 border-t border-subtle p-3 sm:grid-cols-2">
          <Field label="Description" className="sm:col-span-2">
            <TextArea value={line.description_md ?? ''} onChange={(v) => set({ description_md: v || null })} rows={2} placeholder="Markdown — prose, a short list, a table" />
          </Field>
          <Field label="Quantity">
            <TextInput mono value={String(line.qty)} onChange={(v) => set({ qty: Number(v) || 0 })} inputMode="decimal" />
          </Field>
          <Field label="Unit" hint="per hour, per month…">
            <TextInput value={line.unit ?? ''} onChange={(v) => set({ unit: v || null })} />
          </Field>
          <Field label="Discount %" hint="basis points / 100">
            <TextInput
              mono
              value={line.discount_bps ? String(line.discount_bps / 100) : ''}
              onChange={(v) => set({ discount_bps: v ? Math.round(Number(v) * 100) : null, discount_cents: null })}
              inputMode="decimal"
            />
          </Field>
          <Field label="Discount cash" hint="either, never both">
            <MoneyInput cents={line.discount_cents ?? 0} onCents={(c) => set({ discount_cents: c || null, discount_bps: null })} />
          </Field>

          {line.kind === 'milestone' ? (
            <>
              <Field label="Weeks">
                <TextInput mono value={String(line.milestone?.weeks ?? '')} onChange={(v) => set({ milestone: { ...line.milestone, weeks: Number(v) || null } })} inputMode="numeric" />
              </Field>
              <Field label="Payment split" hint="whole percents, summing to 100">
                <TextInput
                  mono
                  value={(line.milestone?.payment_split ?? [50, 50]).join(' / ')}
                  onChange={(v) => {
                    const parts = v.split('/').map((p) => Number(p.trim())).filter((n) => Number.isFinite(n));
                    set({ milestone: { ...line.milestone, payment_split: parts.length ? parts : [50, 50] } });
                  }}
                />
                <span className="mt-1 block font-mono text-[11.5px] tabular-nums text-muted">
                  {/* computeQuote's exact cents, not a re-derivation: the last part
                      absorbs the rounding so the schedule sums to the line. */}
                  {paymentParts(line.amount_cents, line.milestone?.payment_split)
                    .map((c) => formatMoney(c, record.quote.currency, { alwaysCents: true }))
                    .join('  +  ')}
                </span>
              </Field>
              <Field label="Acceptance criteria" className="sm:col-span-2">
                <TextArea
                  rows={2}
                  value={line.milestone?.acceptance_criteria_md ?? ''}
                  onChange={(v) => set({ milestone: { ...line.milestone, acceptance_criteria_md: v || null } })}
                  placeholder="What gets walked through and signed"
                />
              </Field>
            </>
          ) : null}

          {line.recurring ? (
            <>
              <Field label="Interval">
                <Select
                  value={line.recurring.interval}
                  onChange={(v) => set({ recurring: { ...line.recurring, interval: v } })}
                  options={[
                    { value: 'month', label: 'Monthly' },
                    { value: 'quarter', label: 'Quarterly' },
                    { value: 'year', label: 'Yearly' },
                  ]}
                />
              </Field>
              <Field label="Notice days">
                <TextInput mono value={String(line.recurring.notice_days ?? '')} onChange={(v) => set({ recurring: { ...line.recurring, interval: line.recurring?.interval ?? 'month', notice_days: Number(v) || null } })} inputMode="numeric" />
              </Field>
            </>
          ) : null}

          {line.hourly ? (
            <>
              <Field label="Rate">
                <MoneyInput cents={line.hourly.rate_cents} onCents={(c) => set({ hourly: { ...line.hourly, rate_cents: c } })} />
              </Field>
              <Field label="Minimum hours">
                <TextInput mono value={String(line.hourly.minimum_hours ?? '')} onChange={(v) => set({ hourly: { ...line.hourly, rate_cents: line.hourly?.rate_cents ?? 0, minimum_hours: Number(v) || null } })} inputMode="numeric" />
              </Field>
              <label className="flex items-center gap-2 text-[13px] text-secondary sm:col-span-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[rgb(var(--co-accent))]"
                  checked={!!line.hourly.primary}
                  onChange={(e) => set({ hourly: { ...line.hourly, rate_cents: line.hourly?.rate_cents ?? 0, primary: e.target.checked } })}
                />
                Primary hourly line — Project-Ops takes its <code className="font-mono text-[12px]">defaultBillRate</code> from this one (A14). Only one allowed.
              </label>
            </>
          ) : null}

          <Field label="Option group">
            <Select
              value={line.option_group ?? ''}
              onChange={(v) => set({ option_group: v || null, selected: v ? line.selected : false })}
              options={[{ value: '', label: 'Not an option' }, ...groups.map((g) => ({ value: g.key, label: g.label }))]}
            />
          </Field>
          {line.option_group ? (
            <label className="flex items-end gap-2 pb-2 text-[13px] text-secondary">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[rgb(var(--co-accent))]"
                checked={line.selected}
                onChange={(e) => apply((r) => selectOption(r, line.option_group as string, line.id, e.target.checked))}
              />
              Selected in this group
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Switching a line's kind swaps the terms object that kind implies. */
function kindPatch(kind: LineKind): Partial<QuoteLine> {
  return {
    kind,
    recurring: kind === 'recurring' ? { interval: 'month' } : null,
    hourly: kind === 'hourly' ? { rate_cents: 0 } : null,
    milestone: kind === 'milestone' ? { payment_split: [50, 50] } : null,
  };
}

function PriceBookPicker({ draft, sectionId }: { draft: QuoteDraft; sectionId: string }) {
  const [sku, setSku] = useState('');
  const active = useMemo(() => PRICE_BOOK.filter((i) => i.active), []);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        className="w-[280px]"
        value={sku}
        onChange={setSku}
        options={[{ value: '', label: 'Price book…' }, ...active.map((i) => ({ value: i.sku, label: `${i.label} · ${formatMoney(i.default_price_cents, 'USD')}` }))]}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={!sku}
        leading={<Plus className="h-4 w-4" strokeWidth={2.4} />}
        onClick={() => {
          const item = active.find((i) => i.sku === sku);
          if (!item) return;
          draft.apply((r) => addLine(r, lineFromPriceBook(r, sectionId, item)));
          setSku('');
        }}
      >
        Add from price book
      </Button>
      <Button size="sm" variant="ghost" leading={<Plus className="h-4 w-4" strokeWidth={2.4} />} onClick={() => draft.apply((r) => addLine(r, blankLine(r, sectionId)))}>
        Blank line
      </Button>
    </div>
  );
}

function SectionEditor({ draft, section, ordinal }: { draft: QuoteDraft; section: QuoteSection; ordinal: number }) {
  const { apply, record } = draft;
  const lines = record.lines.filter((l) => l.section_id === section.id).sort((a, b) => a.position - b.position);
  const set = (patch: Partial<QuoteSection>) => apply((r) => patchSection(r, section.id, patch));

  return (
    <Panel
      eyebrow={`Section ${ordinal}`}
      title={section.heading || 'Untitled section'}
      action={
        <div className="flex items-center gap-1.5">
          <RowButton onClick={() => apply((r) => moveSection(r, section.id, -1))} label="Move section up">
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.4} />
          </RowButton>
          <RowButton onClick={() => apply((r) => moveSection(r, section.id, 1))} label="Move section down">
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.4} />
          </RowButton>
          <RowButton onClick={() => apply((r) => removeSection(r, section.id))} label="Remove section">
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2.4} />
          </RowButton>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_190px]">
        <Field label="Heading">
          <TextInput value={section.heading} onChange={(v) => set({ heading: v })} />
        </Field>
        <Field label="Kind">
          <Select value={section.kind} onChange={(v) => set({ kind: v })} options={SECTION_KINDS} />
        </Field>
      </div>
      <Field
        label="Body"
        hint={section.kind === 'summary' ? 'the client-facing lede — prose, not bullets' : 'markdown'}
        className="mt-3"
      >
        <TextArea value={section.body_md ?? ''} onChange={(v) => set({ body_md: v || null })} rows={section.kind === 'summary' ? 5 : 3} />
      </Field>

      <div className="mt-4 rounded-token border border-warning/40 bg-warning-subtle/40 p-3">
        <div className="mb-1.5 flex items-center gap-2">
          <Lock className="h-3.5 w-3.5 text-warning" strokeWidth={2.4} />
          <span className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-warning">Basis note · studio margin · never rendered for the client</span>
        </div>
        <TextArea
          value={section.internal_basis_md ?? ''}
          onChange={(v) => set({ internal_basis_md: v || null })}
          rows={2}
          placeholder="Why this number. What we would concede. What the client already signalled."
        />
      </div>

      <div className="mt-4 space-y-2">
        {lines.length === 0 ? (
          <p className="rounded-token border border-dashed border-subtle px-3 py-4 text-center text-[13px] text-muted">No lines in this section yet.</p>
        ) : (
          lines.map((l) => <LineEditor key={l.id} draft={draft} line={l} />)
        )}
      </div>
      <div className="mt-3">
        <PriceBookPicker draft={draft} sectionId={section.id} />
      </div>
    </Panel>
  );
}

export function QuoteComposer({ draft }: { draft: QuoteDraft }) {
  const { record, totals, apply } = draft;
  const q = record.quote;
  const sections = [...record.sections].sort((a, b) => a.position - b.position);
  const costTotal = record.costs.reduce((s, c) => s + c.amount_cents, 0);

  return (
    <div className="space-y-4">
      <Panel title="The paper" eyebrow="Quote">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title" className="sm:col-span-2">
            <TextInput value={q.title} onChange={(v) => apply((r) => patchQuote(r, { title: v }))} />
          </Field>
          <Field label="Number" hint="permanent">
            <TextInput mono value={q.number} onChange={(v) => apply((r) => patchQuote(r, { number: v }))} />
          </Field>
          <Field label="Valid until" hint="30 days is the default">
            <TextInput mono value={q.valid_until} onChange={(v) => apply((r) => patchQuote(r, { valid_until: v }))} placeholder="YYYY-MM-DD" />
          </Field>
          <Field label="Brand" hint="Brand-Ops tokens colour the document">
            <Select value={q.brand_slug ?? ''} onChange={(v) => apply((r) => patchQuote(r, { brand_slug: v || null }))} options={BRANDS} />
          </Field>
          <Field label="Currency">
            <TextInput mono value={q.currency} onChange={(v) => apply((r) => patchQuote(r, { currency: v.toUpperCase() }))} />
          </Field>
        </div>
      </Panel>

      {sections.map((s, i) => (
        <SectionEditor key={s.id} draft={draft} section={s} ordinal={i + 1} />
      ))}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" leading={<Plus className="h-4 w-4" strokeWidth={2.4} />} onClick={() => apply((r) => addSection(r))}>
          Add section
        </Button>
        <Button size="sm" variant="ghost" leading={<Plus className="h-4 w-4" strokeWidth={2.4} />} onClick={() => apply((r) => addOptionGroup(r))}>
          Add option group
        </Button>
      </div>

      <Panel title="Option groups" eyebrow="Packages">
        {q.option_groups.length === 0 ? (
          <p className="text-[13px] text-muted">No option groups. A group turns its lines into the package matrix on the document.</p>
        ) : (
          <div className="space-y-3">
            {q.option_groups.map((g) => {
              const members = record.lines.filter((l) => l.option_group === g.key);
              const selected = members.filter((l) => l.selected).length;
              const bad = g.mode === 'exclusive' && selected !== 1;
              return (
                <div key={g.key} className="rounded-token border border-subtle bg-surface-overlay/50 p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Label" className="min-w-[180px] flex-1">
                      <TextInput value={g.label} onChange={(v) => apply((r) => patchOptionGroup(r, g.key, { label: v }))} />
                    </Field>
                    <Field label="Mode" hint={g.mode === 'exclusive' ? 'pick exactly one' : 'zero or more'}>
                      <Select
                        className="w-[150px]"
                        value={g.mode}
                        onChange={(v) => apply((r) => patchOptionGroup(r, g.key, { mode: v }))}
                        options={[
                          { value: 'exclusive', label: 'Exclusive' },
                          { value: 'additive', label: 'Additive' },
                        ]}
                      />
                    </Field>
                    <div className="pb-2">
                      <RowButton onClick={() => apply((r) => removeOptionGroup(r, g.key))} label="Remove option group">
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={2.4} />
                      </RowButton>
                    </div>
                  </div>
                  <Field label="Intro" className="mt-2">
                    <TextArea rows={2} value={g.intro_md ?? ''} onChange={(v) => apply((r) => patchOptionGroup(r, g.key, { intro_md: v || null }))} />
                  </Field>
                  <p className={cn('mt-2 text-[12.5px]', bad ? 'text-danger' : 'text-muted')}>
                    {members.length} line{members.length === 1 ? '' : 's'} · {selected} selected
                    {bad ? ' — an exclusive group must have exactly one selected before send (A8).' : ''}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Recipients" eyebrow="Who may accept" internal>
        <p className="mb-3 text-[13px] text-secondary">
          When a quote names recipients, only those addresses may accept it (A1). Addresses are studio-only — the document never
          prints them.
        </p>
        <div className="space-y-2">
          {record.recipients.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2">
              <TextInput className="min-w-[140px] flex-1" value={r.name} onChange={(v) => apply((rec) => patchRecipient(rec, r.id, { name: v }))} placeholder="Name" />
              <TextInput className="min-w-[180px] flex-1" value={r.email} onChange={(v) => apply((rec) => patchRecipient(rec, r.id, { email: v }))} placeholder="email@example.com" inputMode="email" />
              <Select
                className="w-[92px]"
                value={r.role}
                onChange={(v) => apply((rec) => patchRecipient(rec, r.id, { role: v }))}
                options={[
                  { value: 'to', label: 'to' },
                  { value: 'cc', label: 'cc' },
                ]}
              />
              <RowButton onClick={() => apply((rec) => removeRecipient(rec, r.id))} label="Remove recipient">
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2.4} />
              </RowButton>
            </div>
          ))}
        </div>
        <Button className="mt-3" size="sm" variant="ghost" leading={<Plus className="h-4 w-4" strokeWidth={2.4} />} onClick={() => apply((r) => addRecipient(r))}>
          Add recipient
        </Button>
      </Panel>

      <Panel title="Direct costs" eyebrow="A3 · own table" internal>
        <p className="mb-3 text-[13px] text-secondary">
          Never in the internal notes, never in a snapshot, never in a render, never sent to Project-Ops. The partner adapter
          receives only the <strong className="font-semibold text-primary">total</strong>.
        </p>
        <div className="space-y-2">
          {record.costs.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2">
              <TextInput className="min-w-[180px] flex-1" value={c.label} onChange={(v) => apply((r) => patchCost(r, c.id, { label: v }))} placeholder="What it is" />
              <Select
                className="w-[130px]"
                value={c.kind}
                onChange={(v) => apply((r) => patchCost(r, c.id, { kind: v }))}
                options={[
                  { value: 'hosting', label: 'hosting' },
                  { value: 'ai_usage', label: 'ai usage' },
                  { value: 'third_party', label: 'third party' },
                  { value: 'other', label: 'other' },
                ]}
              />
              <div className="w-[120px]">
                <MoneyInput cents={c.amount_cents} onCents={(cents) => apply((r) => patchCost(r, c.id, { amount_cents: cents }))} />
              </div>
              <RowButton onClick={() => apply((r) => removeCost(r, c.id))} label="Remove cost">
                <Trash2 className="h-3.5 w-3.5" strokeWidth={2.4} />
              </RowButton>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <Button size="sm" variant="ghost" leading={<Plus className="h-4 w-4" strokeWidth={2.4} />} onClick={() => apply((r) => addCost(r))}>
            Add direct cost
          </Button>
          <span className="font-mono text-[13px] tabular-nums text-secondary">Total {formatMoney(costTotal, q.currency)}</span>
        </div>
      </Panel>

      <Panel title="Partner split" eyebrow="Who invoices whom" internal>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vendor of record">
            <TextInput value={q.vendor_of_record.label} onChange={(v) => apply((r) => patchQuote(r, { vendor_of_record: { ...r.quote.vendor_of_record, label: v } }))} />
          </Field>
          <Field label="Delivery partner">
            <TextInput
              value={q.delivery_partner?.label ?? ''}
              onChange={(v) => apply((r) => patchQuote(r, { delivery_partner: v ? { label: v, contact_ops_org_id: null } : null }))}
              placeholder="none"
            />
          </Field>
          <label className="flex items-start gap-2 text-[13px] text-secondary sm:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[rgb(var(--co-accent))]"
              checked={q.show_delivery_partner !== false}
              disabled={!q.delivery_partner}
              onChange={(e) => apply((r) => patchQuote(r, { show_delivery_partner: e.target.checked }))}
            />
            <span>
              Name the partner on the client&rsquo;s document
              <span className="mt-0.5 block text-[12px] text-muted">
                Adds &ldquo;with {q.delivery_partner?.label ?? 'the partner'}&rdquo; to the proposal line above the title. Off keeps the
                paper in the vendor of record&rsquo;s name only &mdash; the split and the partner bill are unaffected either way,
                because neither ever leaves the workspace.
              </span>
            </span>
          </label>
          <Field label="Rule">
            <Select
              value={q.split_rule.kind}
              onChange={(v) => apply((r) => patchQuote(r, { split_rule: { ...r.quote.split_rule, kind: v } }))}
              options={[
                { value: 'none', label: 'No split' },
                { value: 'percent_net', label: 'Percent of net, after direct costs' },
                { value: 'fee', label: 'Flat fee' },
              ]}
            />
          </Field>
          <Field label="Percent">
            <TextInput mono value={String(q.split_rule.percent ?? '')} onChange={(v) => apply((r) => patchQuote(r, { split_rule: { ...r.quote.split_rule, percent: Number(v) || null } }))} inputMode="numeric" />
          </Field>
          <label className="flex items-center gap-2 text-[13px] text-secondary sm:col-span-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[rgb(var(--co-accent))]"
              checked={!!q.split_rule.hosting_to_partner}
              onChange={(e) => apply((r) => patchQuote(r, { split_rule: { ...r.quote.split_rule, hosting_to_partner: e.target.checked } }))}
            />
            Hosting goes to the delivery partner in full
          </label>
          <Field label="Notes" className="sm:col-span-2">
            <TextArea rows={2} value={q.split_rule.notes ?? ''} onChange={(v) => apply((r) => patchQuote(r, { split_rule: { ...r.quote.split_rule, notes: v || null } }))} />
          </Field>
        </div>
      </Panel>

      <Panel title="Internal notes" eyebrow="Decisions, positions, what we would concede" internal>
        <TextArea rows={6} value={q.internal_notes_md ?? ''} onChange={(v) => apply((r) => patchQuote(r, { internal_notes_md: v || null }))} />
      </Panel>

      <p className="px-1 pb-2 text-[12.5px] text-muted">
        Deposit due on acceptance {formatMoney(totals.deposit_cents, q.currency)} · year one {formatMoney(totals.year_one_cents, q.currency)} — both from{' '}
        <code className="font-mono">computeQuote</code>, the same function the client document and the PDF use.
      </p>
    </div>
  );
}
