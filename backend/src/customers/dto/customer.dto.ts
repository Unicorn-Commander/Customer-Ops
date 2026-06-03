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
