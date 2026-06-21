import { IsEnum } from 'class-validator';
import { WorkspaceRole } from '@prisma/client';

/** Change a workspace member's role (owner-gated). */
export class UpdateMemberRoleDto {
  /** The canonical suite role to assign (VIEWER | MEMBER | MANAGER | ADMIN | OWNER). */
  @IsEnum(WorkspaceRole)
  role!: WorkspaceRole;
}
