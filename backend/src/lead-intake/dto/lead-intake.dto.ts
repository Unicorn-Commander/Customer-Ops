/**
 * Request DTOs for the Customer-Ops lead-ingestion front door (Phase 6).
 *
 * `ingest_lead` is the keystone the leadgen apps (Northwind, Magic Unicorn Outreach,
 * LoopNet, multistate, …) and agents push a graduated, enriched lead through.
 * The push carries IDENTITY (resolved into Contact-Ops, the person SoR) + a
 * ROLLUP (tags/score) + optional PROJECTION seeds (the funnel hints). Money is a
 * decimal STRING (the suite money convention; parsed to Prisma.Decimal).
 *
 * The "must be resolvable" rule (an explicit contactId, OR at least one identity
 * key) is enforced in the service so the 400 message is crisp.
 */

import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LeadIntakeStatus, RelationshipPriority } from '@prisma/client';

/** A decimal string like "1500" or "1500.0000" (NUMERIC(20,4) compatible). */
const DECIMAL_RE = /^\d{1,16}(\.\d{1,4})?$/;
/** The slug charset for a leadgen source + the source's dedup key. */
const SLUG_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Ingest ONE graduated lead. Idempotent on (workspace, source, sourceDedupKey):
 * a re-push UPSERTS the staged intake, never duplicates it.
 */
export class IngestLeadDto {
  /** The leadgen source slug pushing this lead (the SKU/app). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Matches(SLUG_RE, { message: 'source may contain only letters, digits, and . _ : -' })
  source!: string;

  /** The source app's STABLE id for this lead — the idempotency key. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  @Matches(SLUG_RE, { message: 'sourceDedupKey may contain only letters, digits, and . _ : -' })
  sourceDedupKey!: string;

  /**
   * Optional EXPLICIT Contact-Ops contact id. The end-state path: the leadgen
   * app already centralized identity (via `contactops_push`) and tells
   * Customer-Ops the resolved person_id. When present, ingestion skips the
   * Contact-Ops upsert and projects the LEAD directly on this id.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactId?: string;

  // ── Raw inbound identity (resolved INTO Contact-Ops; at least one of these,
  //    or an explicit contactId, is required) ──
  @IsOptional()
  @IsString()
  @MaxLength(300)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  orgName?: string;

  // ── Rollup / enrichment the leadgen app computed ──
  /** Rollup tags (e.g. ['lead','northwind','retirement']). Pushed to Contact-Ops +
   *  carried onto the projection. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  tags?: string[];

  /** Lead score 0–100 (the leadgen app's qualification signal). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  score?: number;

  // ── Optional projection seeds (the funnel hints) ──
  @IsOptional()
  @Matches(DECIMAL_RE, { message: 'expectedValue must be a non-negative decimal string (≤4 dp)' })
  expectedValue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsEnum(RelationshipPriority)
  priority?: RelationshipPriority;

  /** The rep to assign on graduation (uchub sub), if the source knows it. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  ownerUserKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  /** The full inbound envelope, verbatim — kept as the audit/replay trail. */
  @IsOptional()
  @IsObject()
  rawPayload?: Record<string, unknown>;
}

/** Filter/paginate the intake buffer (observability). */
export class ListIntakesQueryDto {
  @IsOptional()
  @IsEnum(LeadIntakeStatus)
  status?: LeadIntakeStatus;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  source?: string;

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

/** Trigger reconciliation: promote the oldest PENDING/FAILED intakes. */
export class ResolvePendingDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  /** Also retry FAILED intakes (default: PENDING only). */
  @IsOptional()
  @IsString()
  @IsEnum(['pending', 'pending_and_failed'] as const, {
    message: "scope must be 'pending' or 'pending_and_failed'",
  })
  scope?: 'pending' | 'pending_and_failed';
}

/** Discard a staged intake (spam / duplicate / opt-out). Terminal. */
export class DiscardIntakeDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
