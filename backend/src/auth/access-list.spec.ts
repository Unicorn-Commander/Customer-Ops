import { WorkspaceRole } from '@prisma/client';
import { resolveUserAccess, __resetAccessListCacheForTests } from './access-list';

/**
 * The SSO access list is the JIT-provisioning gate (SUITE-IDENTITY §D5). A
 * uchub account does NOT by itself grant a Customer-Ops account; the allow-list
 * defines who can sign in + at what canonical suite role on first login.
 */
describe('access-list', () => {
  beforeEach(() => {
    __resetAccessListCacheForTests();
    delete process.env.CUSTOMER_OPS_ACCESS_LIST;
  });

  afterEach(() => {
    __resetAccessListCacheForTests();
    delete process.env.CUSTOMER_OPS_ACCESS_LIST;
  });

  it('falls back to the legacy map (Aaron + Shafen OWNER) when env is unset', () => {
    expect(resolveUserAccess('aaron@magicunicorn.tech')).toMatchObject({
      allowed: true,
      role: WorkspaceRole.OWNER,
    });
    expect(resolveUserAccess('shafenkhan@users.noreply.github.com')).toMatchObject({
      allowed: true,
      role: WorkspaceRole.OWNER,
    });
  });

  it('rejects a stranger (no rule matched)', () => {
    expect(resolveUserAccess('nobody@example.com').allowed).toBe(false);
  });

  it('rejects a null/empty email', () => {
    expect(resolveUserAccess(null).allowed).toBe(false);
    expect(resolveUserAccess('').allowed).toBe(false);
  });

  it('exact match wins over domain wildcard, and uses canonical suite roles', () => {
    process.env.CUSTOMER_OPS_ACCESS_LIST =
      'boss@acme.test:OWNER, *@acme.test:MEMBER, *@vendor.test:VIEWER';
    __resetAccessListCacheForTests();

    expect(resolveUserAccess('boss@acme.test')).toMatchObject({
      allowed: true,
      role: WorkspaceRole.OWNER,
    });
    expect(resolveUserAccess('ic@acme.test')).toMatchObject({
      allowed: true,
      role: WorkspaceRole.MEMBER,
    });
    expect(resolveUserAccess('rep@vendor.test')).toMatchObject({
      allowed: true,
      role: WorkspaceRole.VIEWER,
    });
    expect(resolveUserAccess('rando@other.test').allowed).toBe(false);
  });

  it('drops entries with an unknown role', () => {
    process.env.CUSTOMER_OPS_ACCESS_LIST = 'x@acme.test:SUPERDUPER, y@acme.test:ADMIN';
    __resetAccessListCacheForTests();
    expect(resolveUserAccess('x@acme.test').allowed).toBe(false); // invalid role dropped
    expect(resolveUserAccess('y@acme.test')).toMatchObject({
      allowed: true,
      role: WorkspaceRole.ADMIN,
    });
  });
});
