import { ConflictException, Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { resolveUserAccess, describeAccessList } from './access-list';
import { signupMode } from '../common/workspace/feature-flags';
import { WorkspaceProvisioningService } from '../common/workspace/workspace-provisioning.service';
import { MembershipService } from '../common/workspace/membership.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  username: string;
  /**
   * Entitlement SKUs (the suite entitlement gate). Carried into the locally-minted
   * HS256 session token so the browser path enforces like the forwarded-token path:
   * the OIDC callback reads them off the verified Keycloak access token and bakes
   * them in here, and `JwtStrategy.readEntitlements` reads them back on each request.
   * Absent/empty ⇒ enforce denies (degrade-clean) — see docs/runbooks/entitlement-enforce.md.
   */
  entitlements?: string[];
}

/**
 * Customer-Ops authentication.
 *
 * Greenfield + SSO-only: there is no local password flow. Identity comes from
 * the uchub Keycloak realm (RS256), either via the OIDC browser callback or a
 * forwarded realm/Brigade token. Every entry point JIT-provisions the User row
 * through the SAME access-list gate (SUITE-IDENTITY §D5) so no path bypasses
 * policy, and resolves by `keycloakId`/`sub` FIRST (email is a linking fallback
 * only). A valid token still grants ZERO workspace access until a Membership
 * row exists — that gate lives in MembershipService.
 *
 * SIGNUP MODE (CUSTOMER_OPS_SIGNUP_MODE): the JIT gate for a user the access
 * list does NOT match. Default 'invite' == today's behavior exactly (reject the
 * stranger — invite-only). 'open' == self-serve: the stranger instead
 * auto-provisions their OWN workspace (a new uc-registry workspace id + an OWNER
 * membership) via WorkspaceProvisioningService. An allow-list match ALWAYS wins
 * first, in both modes — open mode only adds a fallback for the uncovered user.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly provisioning: WorkspaceProvisioningService,
    private readonly membership: MembershipService,
  ) {
    const meta = describeAccessList();
    this.logger.log(
      `SSO access list: ${meta.ruleCount} rule${meta.ruleCount === 1 ? '' : 's'} (source: ${meta.source})`,
    );
  }

  /**
   * Resolve (or JIT-provision) the Customer-Ops User for a verified Keycloak
   * identity. Resolution order (SUITE-IDENTITY §D1, brief §6):
   *   1. by keycloakId (== uchub sub) — the canonical key.
   *   2. by email — links an existing local row to this sub (sets keycloakId).
   *   3. neither — JIT-create, GATED by the access list.
   */
  async validateKeycloakUser(keycloakId: string, profile: any): Promise<User> {
    const email: string | undefined = profile?.email;

    // 1. keycloakId / sub first.
    let user = await this.prisma.user.findUnique({ where: { keycloakId } });

    // 2. email linking fallback.
    if (!user && email) {
      user = await this.prisma.user.findUnique({ where: { email } });
      if (user) {
        user = await this.prisma.user.update({ where: { id: user.id }, data: { keycloakId } });
        this.logger.log(`Linked existing user ${email} to Keycloak sub ${keycloakId}`);
      }
    }

    // 3. JIT-provision. The access-list match ALWAYS wins first (unchanged in
    //    both signup modes); the not-matched case is what the signup mode gates.
    if (!user) {
      const access = resolveUserAccess(email);
      if (access.allowed) {
        // Allow-listed: create the user; the membership is seeded at the END of
        // this method (ensureSeededMembership) when tenancy is live — at LOGIN, so
        // the cockpit isn't stranded on an empty workspace list. Identical in
        // invite + open.
        // Username uniqueness: prefer preferred_username, else email; the unique
        // constraint guarantees we never silently collide.
        const username = profile?.preferred_username || profile?.username || email!;
        user = await this.prisma.user.create({
          data: {
            email: email!,
            username,
            firstName: profile?.given_name || profile?.firstName || '',
            lastName: profile?.family_name || profile?.lastName || '',
            keycloakId,
          },
        });
        this.logger.log(
          `Created user from Keycloak SSO: ${email} (role-on-seed ${access.role}; ${access.reason})`,
        );
      } else if (signupMode() === 'open' && email) {
        // Self-serve (open mode): not on the allow-list → auto-provision the
        // user their OWN workspace + OWNER membership in one transaction.
        user = await this.provisionSelfServe(keycloakId, profile, email);
      } else {
        // Invite-only (default): a uchub account does not by itself grant access.
        this.logger.warn(`Rejected SSO JIT for ${email || '(no email)'} — ${access.reason}`);
        throw new UnauthorizedException(
          'You are not authorized for Customer-Ops. Contact your administrator.',
        );
      }
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User account is inactive');
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    // Seed the allow-listed user's membership at LOGIN — not deferred to the first
    // workspace-scoped route. The dashboard's first call after sign-in is
    // GET /auth/me/workspaces (a plain list, no seeding), so without this an
    // allow-listed user on a fresh DB lands on "no workspace membership yet" and
    // never reaches a route that would seed them (the first-login chicken-and-egg
    // that surfaced on the prod stand-up). Idempotent + tenancy-gated; a no-op for
    // self-serve users (who already hold a membership) and when tenancy is off.
    await this.membership.ensureSeededMembership(user);

    // Carry the verified entitlement SKUs onto the resolved user so the OIDC
    // callback can bake them into the minted HS256 session token (the browser
    // path). The KeycloakStrategy reads them off the verified KC access token and
    // passes them on `profile.entitlements`; absent ⇒ [] (enforce denies clean).
    // (The forwarded realm/Brigade token path doesn't rely on this — JwtStrategy
    // re-reads entitlements off that token directly on every request.)
    (user as User & { __entitlements?: string[] }).__entitlements = Array.isArray(
      (profile as { entitlements?: unknown })?.entitlements,
    )
      ? ((profile as { entitlements: unknown[] }).entitlements.map((s) => String(s).trim()).filter(
          Boolean,
        ) as string[])
      : [];

    return user;
  }

  /**
   * Open-signup path: provision a self-serve user (their own workspace + OWNER
   * membership). If two callbacks for the same brand-new sub race, the loser
   * gets a ConflictException from the unique constraints — we recover by
   * re-reading the row the winner just created, so both callers succeed.
   */
  private async provisionSelfServe(keycloakId: string, profile: any, email: string): Promise<User> {
    try {
      const result = await this.provisioning.provisionSelfServeUser({
        keycloakId,
        email,
        username: profile?.preferred_username || profile?.username,
        firstName: profile?.given_name || profile?.firstName,
        lastName: profile?.family_name || profile?.lastName,
      });
      return result.user;
    } catch (err) {
      if (err instanceof ConflictException) {
        const existing = await this.prisma.user.findUnique({ where: { keycloakId } });
        if (existing) return existing;
      }
      throw err;
    }
  }

  /** Mint a local HS256 session token for a resolved user (post OIDC callback). */
  async generateTokenForUser(user: User) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: 'MEMBER',
      username: user.username,
      // Verified entitlement SKUs (stamped by validateKeycloakUser off the KC
      // access token). Baked into the session token so enforce works on the
      // browser path; [] when the bearer carries none.
      entitlements: (user as User & { __entitlements?: string[] }).__entitlements ?? [],
    };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    };
  }

  /**
   * Disambiguate a verified JWT payload by its `iss` claim and resolve the
   * Customer-Ops User (SUITE-IDENTITY §D6):
   *   - Keycloak realm token (`iss` has `/realms/`) OR Brigade federation token
   *     (`iss` in BRIGADE_TRUSTED_ISSUERS) → reuse the validateKeycloakUser path,
   *     so the SAME JIT policy applies (the access list, plus — when
   *     CUSTOMER_OPS_SIGNUP_MODE=open — self-serve provisioning). No path
   *     provisions OUTSIDE that policy.
   *   - Locally-signed session token (no/foreign `iss`) → resolve by local id.
   */
  async validateJwtPayload(payload: any): Promise<User> {
    const issuer: string | undefined = payload?.iss;
    const isKeycloakRealmToken = typeof issuer === 'string' && issuer.includes('/realms/');
    const isBrigadeFederationToken =
      typeof issuer === 'string' && AuthService.brigadeTrustedIssuers().includes(issuer);

    if (isKeycloakRealmToken || isBrigadeFederationToken) {
      // Brigade's transitional sub may be an email; surface it as the profile
      // email so the access-list + email-link path still resolves. Harmless for
      // Keycloak realm tokens (which DO emit email) and for the long-term
      // opaque-sub Brigade model (Brigade emits email separately then).
      const subLooksLikeEmail = typeof payload.sub === 'string' && payload.sub.includes('@');
      const profile = {
        email: payload.email ?? (subLooksLikeEmail ? payload.sub : undefined),
        preferred_username: payload.preferred_username,
        given_name: payload.given_name,
        family_name: payload.family_name,
      };
      return this.validateKeycloakUser(payload.sub, profile);
    }

    // Locally-signed session token.
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }
    return user;
  }

  /**
   * Parse BRIGADE_TRUSTED_ISSUERS (comma-separated). Defaults to the
   * customer-facing prod broker. Set to "" to disable the federation branch.
   * Read each call so test/runtime env changes take effect without a restart.
   */
  private static brigadeTrustedIssuers(): readonly string[] {
    const raw = process.env.BRIGADE_TRUSTED_ISSUERS;
    if (raw === undefined || raw === null) {
      return ['https://brigade.unicorncommander.ai'];
    }
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
