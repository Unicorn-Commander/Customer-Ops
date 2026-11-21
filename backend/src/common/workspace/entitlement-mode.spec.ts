import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipService } from './membership.service';
import { WorkspaceContextService } from './workspace-context.service';
import { PatService } from '../../auth/pat/pat.service';
import {
  entitlementModeFrom,
  resetEntitlementModeLogForTests,
} from './entitlement-mode';

/**
 * Empty UC_ENTITLEMENT_MODE stays enforce (pat.service and
 * workspace-context.service). Boot logs the mode that is actually in force,
 * once per process — not on every request.
 */

function logsOf(run: () => void): string[] {
  const logs: string[] = [];
  const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
    logs.push(String(m));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return logs.filter((line) => line.includes('entitlement mode in force'));
}

describe('entitlement mode boot log', () => {
  beforeEach(() => {
    resetEntitlementModeLogForTests();
  });

  it('treats empty, whitespace, and any non-open value as enforce', () => {
    expect(entitlementModeFrom(undefined)).toBe('enforce');
    expect(entitlementModeFrom(null)).toBe('enforce');
    expect(entitlementModeFrom('')).toBe('enforce');
    expect(entitlementModeFrom('   ')).toBe('enforce');
    expect(entitlementModeFrom('enforce')).toBe('enforce');
    expect(entitlementModeFrom('OPEN')).toBe('open');
    expect(entitlementModeFrom('  open  ')).toBe('open');
  });

  it('logs empty UC_ENTITLEMENT_MODE as enforce once, from both boot constructors', () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const lines = logsOf(() => {
      new PatService({} as PrismaService, {} as MembershipService);
      new WorkspaceContextService(config, {} as PrismaService, {} as MembershipService);
      new PatService({} as PrismaService, {} as MembershipService, undefined, config);
    });
    expect(lines).toEqual(['UC_ENTITLEMENT_MODE=(empty) — entitlement mode in force: enforce.']);
  });

  it('logs an explicit open mode once and does not repeat it', () => {
    const config = {
      get: (k: string) => (k === 'UC_ENTITLEMENT_MODE' ? 'open' : undefined),
    } as unknown as ConfigService;
    const lines = logsOf(() => {
      new PatService({} as PrismaService, {} as MembershipService, undefined, config);
      new WorkspaceContextService(config, {} as PrismaService, {} as MembershipService);
    });
    expect(lines).toEqual(['UC_ENTITLEMENT_MODE=open — entitlement mode in force: open.']);
  });
});
