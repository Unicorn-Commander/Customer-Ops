import { IsIn, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';
import type { OffboardMode } from '../gdpr.service';

/** Body for POST …/gdpr/offboard — how to dispose of the workspace's CRM data. */
export class OffboardWorkspaceDto {
  /**
   * 'delete' (default) removes every CRM row + archives the workspace;
   * 'anonymize' strips PII/free-text but keeps the funnel skeleton.
   */
  @IsOptional()
  @IsIn(['delete', 'anonymize'])
  mode?: OffboardMode;
}

/** Body for PATCH …/gdpr/retention — set/clear the data-retention window. */
export class SetRetentionDto {
  /**
   * Retention window in days (positive integer), or null to DISABLE retention
   * (the default). Null is explicit so an operator can turn the sweep off for a
   * workspace without a separate route.
   */
  @ValidateIf((o: SetRetentionDto) => o.retentionDays !== null)
  @IsInt()
  @Min(1)
  retentionDays!: number | null;
}
