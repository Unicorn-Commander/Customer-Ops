import { z } from 'zod';
import { Prisma } from '@prisma/client';
const quantity = z
  .union([z.number().finite(), z.string().regex(/^\d+(\.\d{1,4})?$/)])
  .refine((value) => {
    const n = new Prisma.Decimal(value);
    return n.isFinite() && n.gte(0) && n.lte(1000000) && n.decimalPlaces() <= 4;
  }, 'qty must be nonnegative with at most four decimal places');
const money = z.number().int().min(0).max(2_000_000_000);
const text = z.string().max(40000);
// Zod 4 applies a field's .default() even when the field is optional, so a plain .partial() of a
// create schema fills every omitted field with its create-time default, and a partial update then
// overwrites stored values (qty -> 1, unit -> 'item', currency -> 'USD', showDeliveryPartner -> true).
// Update schemas drop the defaults before every field becomes optional: an omitted field stays omitted.
type WithoutDefaults<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K];
};
function withoutDefaults<T extends z.ZodRawShape>(shape: T): WithoutDefaults<T> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.unwrap() : field,
    ]),
  ) as WithoutDefaults<T>;
}
export const quoteCreate = z
  .object({
    customerId: z.string().uuid(),
    title: z.string().trim().min(1).max(300),
    currency: z.string().length(3).default('USD'),
    validUntil: z.string().datetime().optional(),
    vendorOfRecord: z.string().trim().min(1).max(200),
    brandSlug: z.string().max(100).nullable().optional(),
    showDeliveryPartner: z.boolean().default(true),
    deliveryPartner: z.string().max(200).nullable().optional(),
    splitRule: z
      .object({
        kind: z.enum(['none', 'percent_net', 'fee']),
        percent: z.number().min(0).max(100).optional(),
        hosting_to_partner: z.boolean().optional(),
        notes: text.optional(),
      })
      .strict()
      .optional(),
    termsMd: text.optional(),
    internalNotesMd: text.optional(),
    parentQuoteId: z.string().uuid().nullable().optional(),
    taxEstimateCents: money.nullable().optional(),
  })
  .strict();
export const quoteUpdate = z
  .object(withoutDefaults(quoteCreate.omit({ customerId: true, parentQuoteId: true }).shape))
  .strict()
  .partial();
export const sectionInput = z
  .object({
    position: z.number().int().min(0).default(0),
    kind: z.enum(['summary', 'scope', 'acceptance', 'terms', 'custom']),
    heading: z.string().max(300),
    bodyMd: text.default(''),
    internalBasisMd: text.default(''),
  })
  .strict();
export const lineInput = z
  .object({
    sectionId: z.string().uuid().nullable().optional(),
    position: z.number().int().min(0).default(0),
    kind: z.enum([
      'one_time',
      'milestone',
      'recurring',
      'hourly',
      'option',
      'included',
      'excluded',
    ]),
    label: z.string().trim().min(1).max(300),
    descriptionMd: text.default(''),
    qty: quantity.default(1),
    unit: z.string().max(50).default('item'),
    unitPriceCents: money,
    discountBps: z.number().int().min(0).max(10000).nullable().optional(),
    discountCents: money.nullable().optional(),
    statusTag: z.enum(['agreed', 'proposed']).default('proposed'),
    recurring: z
      .object({
        interval: z.enum(['month', 'quarter', 'year']),
        term_months: z.number().int().positive().optional(),
        notice_days: z.number().int().nonnegative().optional(),
        included_hours: z.number().nonnegative().optional(),
        ai_allowance_cents: money.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    hourly: z
      .object({
        rate_cents: money,
        minimum_hours: z.number().nonnegative().optional(),
        cadence: z.string().max(100).optional(),
        surcharge_multiplier: z.number().min(1).max(100).optional(),
        primary: z.boolean().default(false),
      })
      .strict()
      .nullable()
      .optional(),
    milestone: z
      .object({
        acceptance_criteria_md: text.optional(),
        weeks: z.number().nonnegative().optional(),
        payment_split: z.array(z.number().int().min(0).max(100)).min(1).max(20).optional(),
      })
      .strict()
      .nullable()
      .optional(),
    paymentSplit: z.array(z.number().int().min(0).max(100)).min(1).max(20).optional(),
    optionGroup: z
      .object({
        id: z.string().min(1).max(100),
        mode: z.enum(['exclusive', 'additive']).default('exclusive'),
      })
      .strict()
      .nullable()
      .optional(),
    selected: z.boolean().default(false),
    priceBookItemId: z.string().uuid().nullable().optional(),
  })
  .strict();
export const lineUpdate = z.object(withoutDefaults(lineInput.shape)).strict().partial();
export const optionsInput = z
  .object({ selectedLineIds: z.array(z.string().uuid()).max(500) })
  .strict();
export const recipientsInput = z
  .object({
    recipients: z
      .array(
        z
          .object({
            name: z.string().max(200),
            email: z
              .string()
              .email()
              .max(320)
              .transform((v) => v.toLowerCase()),
            role: z.enum(['to', 'cc']),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const costInput = z
  .object({
    label: z.string().min(1).max(300),
    amountCents: money,
    kind: z.enum(['hosting', 'ai_usage', 'third_party', 'other']),
    notes: text.default(''),
  })
  .strict();
export const attachmentInput = z
  .object({ assetId: z.string().min(1).max(300), label: z.string().max(300) })
  .strict();
