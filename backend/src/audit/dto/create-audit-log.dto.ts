import { IsString, IsEnum, IsOptional, IsObject } from 'class-validator';
import { AuditAction } from '@prisma/client';

/**
 * The shape AuditService.log() persists. Internal (services call it; it is not a
 * request body), but kept as a validated class to mirror the suite convention.
 *
 * `details` carries STRUCTURAL metadata only (which fields changed, the action
 * kind) — never the free-text content (notes/reasons) or any secret. The
 * relationship's content timeline lives in `customer_activities`; this is the
 * security/compliance trail.
 */
export class CreateAuditLogDto {
  @IsString()
  @IsOptional()
  workspaceId?: string;

  /** The acting uchub subject (Keycloak `sub`). Plain string — no users FK. */
  @IsString()
  @IsOptional()
  userId?: string;

  @IsEnum(AuditAction)
  action: AuditAction;

  /** Target kind, e.g. 'customer' | 'customer_note' | 'invoice_link'. */
  @IsString()
  resource: string;

  @IsString()
  @IsOptional()
  resourceId?: string;

  @IsObject()
  @IsOptional()
  details?: Record<string, unknown>;

  @IsString()
  @IsOptional()
  ipAddress?: string;

  @IsString()
  @IsOptional()
  userAgent?: string;
}
