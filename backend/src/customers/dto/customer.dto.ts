/**
 * Request DTOs for the Customer-Ops relationship cockpit.
 *
 * Validated by the global ValidationPipe (whitelist + forbidNonWhitelisted), so
 * any unexpected field is rejected. Enum values are the canonical Prisma enums.
 * Money (`expectedValue`) is accepted as a decimal STRING to avoid float drift
 * (the suite money convention) and parsed to Prisma.Decimal in the service.
 */

import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RelationshipPriority, RelationshipStage } from '@prisma/client';

/** A decimal string like "1500" or "1500.0000" (NUMERIC(20,4) compatible). */
const DECIMAL_RE = /^-?\d{1,16}(\.\d{1,4})?$/;
/** A non-negative decimal string (amounts/quantities on an invoice line). */
const POS_DECIMAL_RE = /^\d{1,16}(\.\d{1,4})?$/;
/** An ISO date YYYY-MM-DD (AO invoice issue/due dates). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateCustomerDto {
  /** The federated Contact-Ops contact id this relationship is keyed on. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  contactId!: string;

  @IsOptional()
  @IsEnum(RelationshipStage)
  stage?: RelationshipStage;

  @IsOptional()
  @IsEnum(RelationshipPriority)
  priority?: RelationshipPriority;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  /** Assigned rep — the userKey (uchub sub) who owns this relationship. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  ownerUserKey?: string;

  @IsOptional()
  @Matches(DECIMAL_RE, { message: 'expectedValue must be a decimal string (≤4 dp)' })
  expectedValue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;
}

export class UpdateCustomerDto {
  @IsOptional()
  @IsEnum(RelationshipPriority)
  priority?: RelationshipPriority;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  ownerUserKey?: string;

  @IsOptional()
  @Matches(DECIMAL_RE, { message: 'expectedValue must be a decimal string (≤4 dp)' })
  expectedValue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  /** ISO-8601 date-time for the next action on this relationship. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  nextActionAt?: string;
}

/** Move the relationship to a new funnel stage (funnel rules enforced). */
export class TransitionStageDto {
  @IsEnum(RelationshipStage)
  toStage!: RelationshipStage;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** Mark the relationship closed-lost (orthogonal to stage). */
export class MarkLostDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** Append a freeform note to the relationship timeline. */
export class AddNoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}

/** Filter/paginate the customers list. */
export class ListCustomersQueryDto {
  @IsOptional()
  @IsEnum(RelationshipStage)
  stage?: RelationshipStage;

  @IsOptional()
  @IsEnum(RelationshipPriority)
  priority?: RelationshipPriority;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  ownerUserKey?: string;

  /** Include closed-lost relationships (default false). */
  @IsOptional()
  @IsBoolean()
  includeLost?: boolean;

  /** Resolve federated contact summaries for the page (default true). */
  @IsOptional()
  @IsBoolean()
  withContacts?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

// ============================================================
// PHASE 3 — Accounting-Ops invoicing surface
// ============================================================
//
// "Create an invoice from this customer." Customer-Ops assembles a draft and
// hands it to Accounting-Ops (the AR engine / ledger SoR) via
// create_invoice_from_draft, idempotent on (workspace, external_source,
// external_ref). Money fields are decimal STRINGS (NUMERIC(20,4); never float).

/** One invoice line. Amounts/quantities are decimal strings. */
export class InvoiceLineItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  description!: string;

  /** Decimal string (default "1" applied by the service). */
  @IsOptional()
  @Matches(POS_DECIMAL_RE, { message: 'quantity must be a non-negative decimal string (≤4 dp)' })
  quantity?: string;

  /** Decimal string. */
  @IsOptional()
  @Matches(POS_DECIMAL_RE, { message: 'unitPrice must be a non-negative decimal string (≤4 dp)' })
  unitPrice?: string;

  /** Decimal string; AO computes quantity*unitPrice when omitted. */
  @IsOptional()
  @Matches(POS_DECIMAL_RE, { message: 'amount must be a non-negative decimal string (≤4 dp)' })
  amount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxCode?: string;

  @IsOptional()
  @Matches(POS_DECIMAL_RE, { message: 'taxAmount must be a non-negative decimal string (≤4 dp)' })
  taxAmount?: string;

  /** Optional AO revenue account UUID. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  revenueAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  sourceRef?: string;
}

/**
 * Assemble + send an invoice for this customer to Accounting-Ops. The customer
 * (name/email/billing) is supplied by the caller — Customer-Ops does NOT copy
 * the Contact-Ops record; the contactId travels as a thin reference AO stores.
 */
export class CreateInvoiceDto {
  /** AO billing entity UUID (which entity issues the invoice). Required by AO. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  entityId!: string;

  /** Customer display name for the invoice (AO requires it). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  customerName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  customerEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  billingAddress?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineItemDto)
  lineItems!: InvoiceLineItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @Matches(ISO_DATE_RE, { message: 'issueDate must be an ISO date (YYYY-MM-DD)' })
  issueDate?: string;

  @IsOptional()
  @Matches(ISO_DATE_RE, { message: 'dueDate must be an ISO date (YYYY-MM-DD)' })
  dueDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  netTerms?: number;

  /** Invoice-level discount; decimal string. */
  @IsOptional()
  @Matches(POS_DECIMAL_RE, { message: 'discount must be a non-negative decimal string (≤4 dp)' })
  discount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  poNumber?: string;

  /** Start the invoice as 'sent' rather than 'draft'. */
  @IsOptional()
  @IsBoolean()
  autoSend?: boolean;

  /**
   * Optional idempotency key. The deterministic AO external_ref is derived from
   * it: passing the SAME key (e.g. on a retry) returns the SAME AO invoice (AO
   * is idempotent on (workspace, external_source, external_ref)) and writes no
   * duplicate link. Omit it to mint a fresh invoice.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'idempotencyKey may contain only letters, digits, and . _ : -',
  })
  idempotencyKey?: string;
}

// ============================================================
// PHASE 4 — Outreach surface (the Outreach app: Listmonk + Postiz)
// ============================================================
//
// Customer-Ops FEDERATES outreach to the (future) Outreach app and keeps only a
// thin local link. "Start a campaign for this customer" enrolls the customer's
// contact into a campaign/sequence; "schedule a social touch" stages a Postiz
// post. Both are idempotent on a deterministic external_ref (from the optional
// idempotencyKey) and require BOTH customer-ops + outreach entitlements.

/** Enroll this customer's contact into an Outreach campaign/sequence. */
export class StartCampaignDto {
  /** The Outreach campaign/sequence id to enroll into (the app's). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  campaignId!: string;

  /** Optional recipient email override (else the federated contact's primary).
   *  Passed to Outreach for audience binding; Customer-Ops does not store it. */
  @IsOptional()
  @IsString()
  @MaxLength(320)
  contactEmail?: string;

  /** Optional per-enrollment merge fields the app templates into the campaign. */
  @IsOptional()
  mergeFields?: Record<string, string>;

  /** Deterministic idempotency key → external_ref; a retry never double-enrolls. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'idempotencyKey may contain only letters, digits, and . _ : -',
  })
  idempotencyKey?: string;
}

/** Schedule a single Postiz social touch attributed to this customer's contact. */
export class ScheduleSocialTouchDto {
  /** The Postiz channel/account id (the app's; which account posts). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  channelId!: string;

  /** The post body / caption. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;

  /** ISO-8601 when to publish; omit for the app's default (e.g. now). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  scheduledAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'idempotencyKey may contain only letters, digits, and . _ : -',
  })
  idempotencyKey?: string;
}

// ============================================================
// PHASE 4 — Email surface (the Email-Ops app: Stalwart)
// ============================================================
//
// Customer-Ops FEDERATES mailboxes to the (future) Email-Ops app and keeps only
// a thin local link. "Send an email" queues delivery now; "draft" stages the
// agent-inbox approval surface. Both are idempotent on a deterministic
// external_ref and require BOTH customer-ops + email-ops entitlements.

/** Compose an outbound email to this customer's contact (send or draft). */
export class SendEmailDto {
  /** Recipient address (else the federated contact's primary email). Passed to
   *  Email-Ops for addressing; Customer-Ops does not store it. */
  @IsOptional()
  @IsString()
  @MaxLength(320)
  toAddress?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  subject!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50000)
  body!: string;

  /** Reply within an existing Email-Ops thread (threads the reply correctly). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  inReplyToThreadId?: string;

  /** 'send' = deliver now; 'draft' = stage for agent-inbox approval (default send). */
  @IsOptional()
  @IsEnum(['send', 'draft'] as const, { message: "mode must be 'send' or 'draft'" })
  mode?: 'send' | 'draft';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'idempotencyKey may contain only letters, digits, and . _ : -',
  })
  idempotencyKey?: string;
}

// ============================================================
// Omni-channel device messaging (iMessage + SMS via UUDC)
// ============================================================
//
// Send a message through the worker's device bridge. Defaults to dry-run unless
// CONVERSATIONS_OPS_LIVE_SEND_ENABLED=true (Aaron-attended checkpoint). Customer-
// Ops never stores the body; the device is the SoR.

/** Compose an outbound device message (iMessage or SMS) to this customer's contact. */
export class SendMessageDto {
  /** Recipient handle (phone e164 or Apple ID email). Else the contact's primary phone. */
  @IsOptional()
  @IsString()
  @MaxLength(320)
  to?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;

  /** 'iMessage' | 'SMS' | omit for auto (device picks). */
  @IsOptional()
  @IsEnum(['iMessage', 'SMS', 'imessage', 'sms'] as const, {
    message: "channel must be 'iMessage' or 'SMS'",
  })
  channel?: 'iMessage' | 'SMS' | 'imessage' | 'sms';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'idempotencyKey may contain only letters, digits, and . _ : -',
  })
  idempotencyKey?: string;
}

// ============================================================
// PHASE 4 — the engagement → funnel-stage hook
// ============================================================
//
// An inbound engagement signal (a reply/click/open from Outreach or Email-Ops,
// or a bounce) advances the customer's funnel stage when it is a positive
// signal, with an append-only activity row recording WHY. This DTO is the
// service/endpoint contract the Outreach/Email-Ops webhooks (or an agent) call.

/** The normalized engagement signal kinds (mirrors OutreachEngagementKind). */
export const ENGAGEMENT_KINDS = [
  'opened',
  'clicked',
  'replied',
  'bounced',
  'unsubscribed',
] as const;
export type EngagementKind = (typeof ENGAGEMENT_KINDS)[number];

export class RecordEngagementDto {
  /** Which engagement happened. 'replied'/'clicked' can advance the funnel;
   *  'opened' is recorded but (by default) does not advance; 'bounced'/
   *  'unsubscribed' never advance (data-quality / suppression signals). */
  @IsEnum(ENGAGEMENT_KINDS, {
    message: `kind must be one of: ${ENGAGEMENT_KINDS.join(', ')}`,
  })
  kind!: EngagementKind;

  /** Where the signal came from (for the activity body + provenance). */
  @IsOptional()
  @IsEnum(['outreach', 'email-ops'] as const, {
    message: "source must be 'outreach' or 'email-ops'",
  })
  source?: 'outreach' | 'email-ops';

  /** The Outreach touch / Email-Ops message/thread id the signal is about. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalRef?: string;

  /** A short human detail for the timeline (e.g. "clicked the proposal link"). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  detail?: string;
}
