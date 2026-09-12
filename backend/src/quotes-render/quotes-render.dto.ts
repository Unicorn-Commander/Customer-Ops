/**
 * Wire validation for the render surfaces — zod schemas (the backend already
 * depends on zod). The global ValidationPipe whitelists class properties; the
 * bodies here are free-form JSON, so the controllers validate with these.
 */

import { z } from 'zod';

const money = z.number().int().min(-1_000_000_000).max(1_000_000_000);
const id = z.string().min(1).max(120);
const md = z.string().max(20_000).nullable();

export const RecurringSchema = z.object({
  interval: z.enum(['month', 'quarter', 'year']),
  term_months: z.number().int().nullable().optional(),
  notice_days: z.number().int().nullable().optional(),
  included_hours: z.number().nullable().optional(),
  ai_allowance_cents: money.nullable().optional(),
});

export const HourlySchema = z.object({
  rate_cents: money,
  minimum_hours: z.number().nullable().optional(),
  cadence: z.string().max(200).nullable().optional(),
  surcharge_multiplier: z.number().nullable().optional(),
  primary: z.boolean().optional(),
});

export const MilestoneSchema = z.object({
  acceptance_criteria_md: md.optional(),
  weeks: z.number().nullable().optional(),
  payment_split: z.array(z.number()).nullable().optional(),
});

export const LineSchema = z.object({
  id,
  quote_id: id,
  section_id: id,
  position: z.number(),
  kind: z.enum(['one_time', 'milestone', 'recurring', 'hourly', 'option', 'included', 'excluded']),
  label: z.string().min(1).max(300),
  description_md: md,
  qty: z.number().min(0).max(1_000_000),
  unit: z.string().max(60).nullable(),
  unit_price_cents: money,
  amount_cents: money,
  discount_bps: z.number().int().min(0).max(10_000).nullable().optional(),
  discount_cents: money.nullable().optional(),
  status_tag: z.enum(['agreed', 'proposed']),
  recurring: RecurringSchema.nullable(),
  hourly: HourlySchema.nullable(),
  milestone: MilestoneSchema.nullable(),
  option_group: z.string().max(60).nullable(),
  selected: z.boolean(),
  price_book_item_id: z.string().nullable(),
  features: z.array(z.object({ label: z.string().max(200), value: z.string().max(400) })).nullable().optional(),
});

export const SectionSchema = z.object({
  id,
  quote_id: id,
  position: z.number(),
  kind: z.enum(['summary', 'scope', 'acceptance', 'terms', 'custom']),
  heading: z.string().max(300),
  body_md: md,
  internal_basis_md: md,
});

export const OrgRefSchema = z.object({ label: z.string().max(200), contact_ops_org_id: z.string().nullable().optional() });

export const LetterheadSchema = z.object({
  legal_name: z.string().max(200),
  address_lines: z.array(z.string().max(200)).max(6),
  tax_id_label: z.string().max(40).nullable().optional(),
  tax_id: z.string().max(60).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  website: z.string().max(200).nullable().optional(),
});

export const FederationSchema = z.object({
  status: z.enum(['pending', 'partial', 'complete', 'failed']),
  cursors: z.object({
    project_ops: z.enum(['pending', 'done', 'failed', 'skipped']),
    accounting_ops: z.enum(['pending', 'done', 'failed', 'skipped']),
    partner: z.enum(['pending', 'done', 'failed', 'skipped']),
  }),
  project_ops_project_id: z.string().nullable(),
  accounting_ops_invoice_ids: z.array(z.string()),
  accounting_ops_schedule_ids: z.array(z.string()),
  partner_invoice_id: z.string().nullable(),
  last_error: z.string().nullable(),
});

export const QuoteSchema = z.object({
  id,
  workspace_id: z.string(),
  customer_id: z.string(),
  number: z.string().max(40),
  title: z.string().max(300),
  status: z.enum(['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'voided']),
  currency: z.string().length(3),
  valid_until: z.string().max(40),
  brand_slug: z.string().max(64).nullable(),
  vendor_of_record: OrgRefSchema,
  delivery_partner: OrgRefSchema.nullable(),
  split_rule: z.object({ kind: z.enum(['none', 'percent_net', 'fee']), percent: z.number().nullable().optional(), hosting_to_partner: z.boolean().optional(), notes: z.string().max(4000).nullable().optional() }),
  terms_md: md,
  internal_notes_md: md,
  tax_estimate_cents: money.nullable(),
  option_groups: z.array(z.object({ key: z.string().max(60), label: z.string().max(200), mode: z.enum(['exclusive', 'additive']), intro_md: md.optional() })),
  customer: z.object({ display_name: z.string().max(200), org_name: z.string().max(200).nullable(), attention: z.string().max(200).nullable() }),
  letterhead: LetterheadSchema,
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  sent_at: z.string().nullable(),
  accepted_at: z.string().nullable(),
  accepted_by: z.object({ name: z.string(), email: z.string(), title: z.string().nullable(), ip: z.string().nullable().optional(), ua: z.string().nullable().optional(), recorded_by_member: z.string().nullable().optional(), how: z.string().nullable().optional() }).nullable(),
  decline_reason: z.string().nullable(),
  current_version_no: z.number().int(),
  locked_for_send: z.boolean(),
  federated: FederationSchema,
  parent_quote_id: z.string().nullable(),
});

export const RecordSchema = z.object({
  quote: QuoteSchema,
  sections: z.array(SectionSchema).max(50),
  lines: z.array(LineSchema).max(500),
  costs: z.array(z.object({ id, quote_id: id, label: z.string().max(200), amount_cents: money, kind: z.enum(['hosting', 'ai_usage', 'third_party', 'other']), notes: z.string().max(2000).nullable() })).max(100),
  recipients: z.array(z.object({ id, quote_id: id, name: z.string().max(200), email: z.string().max(200), role: z.enum(['to', 'cc']), added_by: z.string().nullable() })).max(50),
  versions: z.array(z.object({ id, quote_id: id, version_no: z.number().int(), disposition: z.enum(['current', 'superseded', 'accepted']), created_at: z.string(), render_hash: z.string().nullable(), pdf_asset_ref: z.string().nullable() })).max(200),
  share_tokens: z.array(z.object({ id, quote_version_id: id, token: z.string(), expires_at: z.string(), revoked_at: z.string().nullable(), view_count: z.number(), last_viewed_at: z.string().nullable() })).max(200),
  events: z.array(z.object({ id, quote_id: id, at: z.string(), actor: z.string(), kind: z.string(), data: z.record(z.unknown()).nullable(), ip: z.string().nullable(), ua: z.string().nullable() })).max(2000),
});

export const PreviewBodySchema = z.object({
  record: RecordSchema,
  mode: z.enum(['client', 'studio']).default('client'),
  brand_slug: z.string().max(64).nullable().optional(),
  page_size: z.enum(['letter', 'a4']).optional(),
  /** Studio preview of a state other than the live one (design review). */
  state: z.enum(['open', 'accepted', 'superseded', 'expired', 'draft']).optional(),
});

export const AcceptBodySchema = z.object({
  name: z.string().max(200).default(''),
  email: z.string().max(320).default(''),
  title: z.string().max(200).nullable().optional(),
  accepted: z.union([z.boolean(), z.string()]).optional(),
  selected_line_ids: z.union([z.array(z.string().max(120)).max(100), z.string().max(4000)]).optional(),
});

export const ConfirmBodySchema = z.object({
  pending_id: z.string().max(120).nullable().optional(),
  code: z.string().max(12).default(''),
});

export type PreviewBody = z.infer<typeof PreviewBodySchema>;
