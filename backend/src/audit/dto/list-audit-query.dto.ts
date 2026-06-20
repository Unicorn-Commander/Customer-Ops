import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuditAction } from '@prisma/client';

/**
 * Validate + paginate the workspace audit trail. Previously these arrived as raw
 * `@Query` strings and `action` was cast straight to the Prisma enum, so a bogus
 * `?action=FOO` reached the DB and surfaced as a 500. Routing them through this
 * DTO (global ValidationPipe: whitelist + transform) makes an invalid filter a
 * clean 400 and bounds the page like every other list endpoint.
 */
export class ListAuditQueryDto {
  /** Rows to skip (offset). */
  @IsOptional()
  @IsInt()
  @Min(0)
  skip?: number;

  /** Page size (clamped 1..200 server-side). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  /** Filter by action verb (CREATE/UPDATE/DELETE/EXECUTE/…). */
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  /** Filter by target resource type (e.g. "customer", "agent"). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  resource?: string;
}
