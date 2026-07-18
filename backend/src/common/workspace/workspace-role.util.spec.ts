import { WorkspaceRole } from '@prisma/client';
import { roleMeetsMinimum, WORKSPACE_ROLE_RANK } from './workspace-role.util';

describe('workspace-role.util', () => {
  describe('WORKSPACE_ROLE_RANK', () => {
    it('is a strictly ascending ladder VIEWER < MEMBER < MANAGER < ADMIN < OWNER', () => {
      expect(WORKSPACE_ROLE_RANK.VIEWER).toBeLessThan(WORKSPACE_ROLE_RANK.MEMBER);
      expect(WORKSPACE_ROLE_RANK.MEMBER).toBeLessThan(WORKSPACE_ROLE_RANK.MANAGER);
      expect(WORKSPACE_ROLE_RANK.MANAGER).toBeLessThan(WORKSPACE_ROLE_RANK.ADMIN);
      expect(WORKSPACE_ROLE_RANK.ADMIN).toBeLessThan(WORKSPACE_ROLE_RANK.OWNER);
    });

    it('ranks every WorkspaceRole enum value (no gaps as the enum grows)', () => {
      for (const role of Object.values(WorkspaceRole)) {
        expect(typeof WORKSPACE_ROLE_RANK[role]).toBe('number');
      }
    });
  });

  describe('roleMeetsMinimum', () => {
    it('a VIEWER meets VIEWER but not MEMBER/OWNER (read-only)', () => {
      expect(roleMeetsMinimum(WorkspaceRole.VIEWER, WorkspaceRole.VIEWER)).toBe(true);
      expect(roleMeetsMinimum(WorkspaceRole.VIEWER, WorkspaceRole.MEMBER)).toBe(false);
      expect(roleMeetsMinimum(WorkspaceRole.VIEWER, WorkspaceRole.OWNER)).toBe(false);
    });

    it('a MEMBER meets MEMBER (mutations) but not OWNER (member mgmt)', () => {
      expect(roleMeetsMinimum(WorkspaceRole.MEMBER, WorkspaceRole.MEMBER)).toBe(true);
      expect(roleMeetsMinimum(WorkspaceRole.MEMBER, WorkspaceRole.OWNER)).toBe(false);
    });

    it('intermediate roles (MANAGER/ADMIN) can mutate but only OWNER manages members', () => {
      expect(roleMeetsMinimum(WorkspaceRole.MANAGER, WorkspaceRole.MEMBER)).toBe(true);
      expect(roleMeetsMinimum(WorkspaceRole.ADMIN, WorkspaceRole.MEMBER)).toBe(true);
      expect(roleMeetsMinimum(WorkspaceRole.MANAGER, WorkspaceRole.OWNER)).toBe(false);
      expect(roleMeetsMinimum(WorkspaceRole.ADMIN, WorkspaceRole.OWNER)).toBe(false);
    });

    it('an OWNER meets every requirement', () => {
      expect(roleMeetsMinimum(WorkspaceRole.OWNER, WorkspaceRole.VIEWER)).toBe(true);
      expect(roleMeetsMinimum(WorkspaceRole.OWNER, WorkspaceRole.MEMBER)).toBe(true);
      expect(roleMeetsMinimum(WorkspaceRole.OWNER, WorkspaceRole.OWNER)).toBe(true);
    });

    it('a null/undefined role (non-member) fails closed against any minimum', () => {
      expect(roleMeetsMinimum(null, WorkspaceRole.VIEWER)).toBe(false);
      expect(roleMeetsMinimum(undefined, WorkspaceRole.MEMBER)).toBe(false);
    });
  });
});
