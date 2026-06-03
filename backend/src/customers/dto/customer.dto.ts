/**
 * Request DTOs for the Customer-Ops relationship cockpit.
 *
 * Validated by the global ValidationPipe (whitelist + forbidNonWhitelisted), so
 * any unexpected field is rejected. Enum values are the canonical Prisma enums.
 * Money (`expectedValue`) is accepted as a decimal STRING to avoid float drift
 * (the suite money convention) and parsed to Prisma.Decimal in the service.
 */

import {
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
} from 'class-validator';
import { RelationshipPriority, RelationshipStage } from '@prisma/client';

/** A decimal string like "1500" or "1500.0000" (NUMERIC(20,4) compatible). */
const DECIMAL_RE = /^-?\d{1,16}(\.\d{1,4})?$/;

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
