import { WorkspaceInvitationsService } from '../common/workspace/workspace-invitations.service';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  Logger,
  Optional,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';
import { resolveUserAccess, describeAccessList } from './access-list';
import { signupMode } from '../common/workspace/feature-flags';
import { WorkspaceProvisioningService } from '../common/workspace/workspace-provisioning.service';
import { MembershipService } from '../common/workspace/membership.service';
import { ContactOpsLinkService } from '../contact-ops/contact-ops-link.service';
import { customerOpsEntitlementsEnabled, resolveOrgEntitlement } from './org-entitlements.client';
import {
  UserinfoResolution,
  fetchRealmUserinfo,
  isUserinfoCandidate,
  userinfoFetchEnabled,
} from './userinfo';

export const NO_WORKSPACE_ACCESS_RESPONSE = {
  error: 'no_workspace_access',
  message: 'You are signed in but have no Customer-Ops access. Contact your administrator.',
} as const;

/**
 * Verified token, correct shape, zero Customer-Ops admission: the 403 a web
 * connector must get (a 401 `invalid_token` would make it re-run sign-in in a
 * loop). Same body as the email-path NoWorkspaceAccessException — the guard's
 * `isNoWorkspaceAccessError` already maps `error: 'no_workspace_access'` to the
 * 403 insufficient_scope header on /api/v1/mcp — with a message that is true
 * for the no-email bearer case.
 */
export class ConnectorAdmissionException extends ForbiddenException {
  constructor() {
    super({
      error: 'no_workspace_access',
      message:
        'You are signed in to the realm but have no Customer-Ops access. Ask your administrator to grant you access.',
    });
  }
}

export class NoWorkspaceAccessException extends ForbiddenException {
  constructor() {
    super(NO_WORKSPACE_ACCESS_RESPONSE);
  }
}

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
  email_verified?: boolean;
}

export interface KeycloakValidationOptions {
  /** Bearer callers cache the endpoint verdict; browser callbacks re-check. */
  cacheEntitlement?: boolean;
  /** Verified bearer expiry, in seconds, for the bounded verdict cache. */
  tokenExp?: number;
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
    private readonly invitations: WorkspaceInvitationsService,
    // AUD-CR-1: links a signed-in person's workspaces to their Contact-Ops tenant.
    @Optional() private readonly contactLinks?: ContactOpsLinkService,
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
  async validateKeycloakUser(
    keycloakId: string,
    profile: any,
    forwardedAccessToken?: string,
    options?: KeycloakValidationOptions,
    userinfoToken?: { iss?: unknown; exp?: unknown },
  ): Promise<User> {
    const email: string | undefined = profile?.email;

    // 1. keycloakId / sub first.
    let user = await this.prisma.user.findUnique({ where: { keycloakId } });

    // 2. Exact normalized email fallback. A verified email is required to
    // link an unbound legacy row; an already-linked identity is never rebound.
    if (!user && email) {
      const matches = await this.prisma.user.findMany({
        where: { email: { equals: email.trim(), mode: 'insensitive' } },
        take: 2,
      });
      if (matches.length > 1) throw new UnauthorizedException('Ambiguous identity email.');
      user = matches[0] ?? null;
      if (user) {
        if (
          profile?.email_verified !== true ||
          (user.keycloakId && user.keycloakId !== keycloakId)
        ) {
          throw new UnauthorizedException('Verified identity does not match the existing account.');
        }
        if (!user.keycloakId) {
          const linked = await this.prisma.user.updateMany({
            where: { id: user.id, keycloakId: null },
            data: { keycloakId },
          });
          user = await this.prisma.user.findUnique({ where: { id: user.id } });
          if (!user || user.keycloakId !== keycloakId || linked.count > 1) {
            throw new UnauthorizedException('Identity linking conflict.');
          }
        }
      }
    }

    // 3. Resolve the Ops-Center organization before the legacy JIT branches.
    //    Strategies only forward a human Keycloak realm token; this extra guard
    //    keeps a directly-called federation/PAT-shaped path inert as well.
    let orgEntitlement: Awaited<ReturnType<typeof resolveOrgEntitlement>> | null = null;
    const mayResolveOrgEntitlement =
      typeof forwardedAccessToken === 'string' &&
      forwardedAccessToken.trim() !== '' &&
      !forwardedAccessToken.startsWith('co_pat_') &&
      !profile?.__federationActor &&
      !profile?.act &&
      !profile?.client_id &&
      !profile?.clientId;
    if (mayResolveOrgEntitlement && customerOpsEntitlementsEnabled()) {
      orgEntitlement = await resolveOrgEntitlement(forwardedAccessToken, {
        subject: keycloakId,
        exp: options?.tokenExp,
        cache: options?.cacheEntitlement === true,
      });
    }

    if (orgEntitlement?.allowed && orgEntitlement.orgId && user?.isActive !== false) {
      const verifiedEmail =
        profile?.email_verified === true &&
        typeof email === 'string' &&
        (!user || email.trim().toLowerCase() === user.email.trim().toLowerCase());
      if (!verifiedEmail && !user) {
        this.logger.warn(
          `Entitled Customer-Ops identity ${keycloakId} has no verified email; using legacy admission`,
        );
      } else if (!verifiedEmail) {
        this.logger.warn(
          `Entitled Customer-Ops identity ${keycloakId} email is not verified; using legacy admission`,
        );
      } else {
        if (!user) user = await this.createEntitledUser(keycloakId, profile, email!);
        await this.provisioning.provisionEntitledOrgWorkspace({
          user,
          orgId: orgEntitlement.orgId,
          orgName: orgEntitlement.orgName,
          role: orgEntitlement.role,
        });
      }
    }

    // PO-CONN (step 3.5): a VERIFIED no-email realm human bearer may resolve
    // through the realm userinfo endpoint BEFORE the JIT branches, so the
    // resolved email flows through the normal access-list + create path. The
    // resolver runs only when the userinfo fetch is armed (flag on + trusted
    // realm HUMAN-session token, `sub` not already linked, no email claim) —
    // with the flag off the JWT path skips the resolver entirely and this
    // method's behavior is byte-for-byte today's (no 401→403 change).
    const userinfoArmed =
      typeof forwardedAccessToken === 'string' &&
      userinfoFetchEnabled() &&
      typeof userinfoToken?.iss === 'string' &&
      userinfoToken.iss.trim() !== '';
    if (userinfoArmed && !user && !email) {
      const outcome = await this.resolveRealmUserinfo(
        keycloakId,
        forwardedAccessToken,
        userinfoToken as { iss: string; exp?: number },
      );
      // Transient/unverifiable (5xx, timeout, transport, non-JSON, sub
      // mismatch): NOT an admission verdict. A 403 here would tell a web
      // connector to stop retrying sign-in, and the verdict is cached up to
      // 900 s — so a 3 s Keycloak blip would stick. Keep today's 401.
      if (outcome.outcome !== 'profile') {
        this.logger.warn(
          `Realm userinfo unresolved for ${keycloakId} (${outcome.outcome}); keeping the 401 sign-in answer`,
        );
        throw new UnauthorizedException('Invalid token');
      }
      const userinfo = outcome.profile!;
      if (userinfo.email) {
        return this.validateKeycloakUser(
          keycloakId,
          { ...profile, ...userinfo },
          forwardedAccessToken,
          options,
          userinfoToken,
        );
      }
      // The realm VERIFIED this bearer as a human identity (sub matched the
      // token, profile fetched) but the existing gate below will still reject
      // it (no email to key on, or no access). That is the 403 "signed in, no
      // access" answer — never the 401 that loops a connector into sign-in.
      return this.validateKeycloakUser(
        keycloakId,
        { ...profile, __poConnVerified: true },
        forwardedAccessToken,
        options,
        userinfoToken,
      );
    }

    // 4. JIT-provision. The access-list match ALWAYS wins first (unchanged in
    //    both signup modes) when the new entitlement path did not admit the
    //    caller; the not-matched case is what the signup mode gates.
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
      } else if (
        email &&
        profile?.email_verified === true &&
        !profile?.client_id &&
        !profile?.clientId &&
        !profile?.act &&
        !profile?.__federationActor &&
        (await this.invitations.permitsIdentity(email))
      ) {
        // Admission creates only identity. The exact one-time token must still
        // be accepted by this verified email to create a scoped membership.
        try {
          user = await this.prisma.user.create({
            data: {
              email: email.trim().toLowerCase(),
              keycloakId,
              username: profile?.preferred_username || email.trim().toLowerCase(),
              firstName: profile?.given_name || '',
              lastName: profile?.family_name || '',
            },
          });
        } catch (error) {
          user = await this.prisma.user.findUnique({ where: { keycloakId } });
          if (!user || user.email.trim().toLowerCase() !== email.trim().toLowerCase()) throw error;
        }
      } else if (signupMode() === 'open' && email) {
        // Self-serve (open mode): not on the allow-list → auto-provision the
        // user their OWN workspace + OWNER membership in one transaction.
        user = await this.provisionSelfServe(keycloakId, profile, email);
      } else {
        // Invite-only (default): a uchub account does not by itself grant access.
        // A no-email bearer that reached here had the userinfo resolver run
        // (step 3.5) and the realm VERIFIED it as a human identity (`__poConnVerified`)
        // that this gate still rejects — the 403, never a 401, so a connector
        // stops looping on sign-in. Everything else (flag off, machine/
        // delegation tokens, unverifiable bearers) keeps today's 401.
        const verifiedHuman = profile?.__poConnVerified === true;
        this.logger.warn(
          `Rejected SSO JIT for ${email || '(no email)'} — ${access.reason}${verifiedHuman ? ' (verified realm identity)' : ''}`,
        );
        if (email) throw new NoWorkspaceAccessException();
        if (verifiedHuman) throw new ConnectorAdmissionException();
        throw new UnauthorizedException('Invalid token');
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

    // AUD-CR-1: a PERSON's sign-in links each of their workspaces to its
    // Contact-Ops tenant (first sign-in, and again on a later sign-in if the
    // tenant appeared after). Never for a service, delegated or federation token.
    if (AuthService.isPersonProfile(profile)) this.linkContactOps(user);

    // Carry the verified entitlement SKUs onto the resolved user so the OIDC
    // callback can bake them into the minted HS256 session token (the browser
    // path). The KeycloakStrategy reads them off the verified KC access token and
    // passes them on `profile.entitlements`; absent ⇒ [] (enforce denies clean).
    // (The forwarded realm/Brigade token path doesn't rely on this — JwtStrategy
    // re-reads entitlements off that token directly on every request.)
    (user as User & { __entitlements?: string[] }).__entitlements = Array.isArray(
      (profile as { entitlements?: unknown })?.entitlements,
    )
      ? ((profile as { entitlements: unknown[] }).entitlements
          .map((s) => String(s).trim())
          .filter(Boolean) as string[])
      : [];

    (user as User & { __verifiedEmail?: string | null }).__verifiedEmail =
      profile?.email_verified === true &&
      typeof email === 'string' &&
      email.trim().toLowerCase() === user.email.trim().toLowerCase()
        ? user.email.trim().toLowerCase()
        : null;
    return user;
  }

  /**
   * PO-CONN: resolve a verified no-email realm human bearer through the realm
   * userinfo endpoint. Runs ONLY on the forwarded-bearer path (a browser
   * callback always arrives with a profile) and ONLY for a trusted realm
   * HUMAN-session token whose `sub` is not already linked locally (guard (a)
   * — an already-linked sub never triggers a fetch). Returns the resolution
   * OUTCOME: `profile` carries the merged profile fields (email,
   * email_verified AND-ed with the same machine guard as the email-claim
   * path, names, preferred_username); `refused` is a deliberate refusal
   * (untrusted issuer, machine shape, subject mismatch); `unavailable` is a
   * transient transport failure — the caller maps those to 401, only a
   * resolved profile that the gate rejects becomes the 403.
   * The bearer is passed as a parameter (never stored on the singleton); it is
   * never logged and only its sha256 digest (plus the sub) keys the cache.
   */
  private async resolveRealmUserinfo(
    keycloakId: string,
    bearer: string,
    token: { iss: string; exp?: number },
  ): Promise<UserinfoResolution> {
    const refused = (reason: string): UserinfoResolution => ({
      outcome: 'refused',
      profile: null,
      reason,
    });
    // The bearer is the per-request input: an empty one resolves nothing
    // (there is no credential to send, and no digest to key a cache entry on).
    if (typeof bearer !== 'string' || bearer.trim() === '') return refused('empty bearer');
    // keycloakId is the verified JWT `sub` (payload.sub from the strategy); the
    // strategy's profile projection drops it, so use keycloakId directly.
    if (typeof keycloakId !== 'string' || keycloakId.trim() === '') return refused('empty subject');
    const iss = token.iss;
    const primary = AuthService.primaryRealmIssuer();
    const trusted = AuthService.trustedRealmIssuers();
    if (trusted.size === 0 || !trusted.has(iss)) return refused('untrusted realm issuer');
    if (primary !== null && iss !== primary) return refused('not the primary realm issuer');
    if (!isUserinfoCandidate({ iss, sub: keycloakId }, [primary ?? '']))
      return refused('not a realm human-session token');
    // Guard (a): an already-linked sub never triggers a fetch.
    if (await this.prisma.user.findUnique({ where: { keycloakId } }))
      return refused('subject already linked locally');

    const resolution = await fetchRealmUserinfo({
      trustedIssuers: [primary ?? ''],
      issuer: iss,
      sub: keycloakId,
      exp: typeof token.exp === 'number' && Number.isFinite(token.exp) ? token.exp : undefined,
      cache: true,
      bearer,
    });
    if (resolution.outcome !== 'profile' || !resolution.profile) return resolution;
    const fetched = resolution.profile;
    // The same machine guard the email-claim path uses, AND-ed into
    // email_verified (guard (c)).
    const machine = fetched.act != null || fetched.client_id != null || fetched.clientId != null;
    const email =
      typeof fetched.email === 'string' && fetched.email.trim() !== '' ? fetched.email : undefined;
    return {
      outcome: 'profile',
      profile: {
        sub: fetched.sub,
        email,
        email_verified: !machine && fetched.email_verified === true && email !== undefined,
        preferred_username:
          typeof fetched.preferred_username === 'string' ? fetched.preferred_username : undefined,
        given_name: typeof fetched.given_name === 'string' ? fetched.given_name : undefined,
        family_name: typeof fetched.family_name === 'string' ? fetched.family_name : undefined,
      },
      reason: resolution.reason,
    };
  }

  /**
   * Open-signup path: provision a self-serve user (their own workspace + OWNER
   * membership). If two callbacks for the same brand-new sub race, the loser
   * gets a ConflictException from the unique constraints — we recover by
   * re-reading the row the winner just created, so both callers succeed.
   */
  private async createEntitledUser(keycloakId: string, profile: any, email: string): Promise<User> {
    try {
      return await this.prisma.user.create({
        data: {
          email: email.trim(),
          username: profile?.preferred_username || profile?.username || email.trim(),
          firstName: profile?.given_name || profile?.firstName || '',
          lastName: profile?.family_name || profile?.lastName || '',
          keycloakId,
        },
      });
    } catch (error) {
      const existing = await this.prisma.user.findUnique({ where: { keycloakId } });
      if (existing && existing.email.trim().toLowerCase() === email.trim().toLowerCase()) {
        return existing;
      }
      throw error;
    }
  }

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

  /**
   * Ask the Contact-Ops org lookup for the link row of every workspace the
   * person holds an ACTIVE membership in (AUD-CR-1), keyed by the stored
   * membership rows, never a claim. Not awaited: sign-in never waits on, or
   * fails because of, Contact-Ops. Linked is a no-op; no tenant yet is retried
   * at a later sign-in after the back-off (ContactOpsLinkService).
   * Throttled per person there, so a per-request sign-in stays cheap.
   */
  private linkContactOps(user: User): void {
    const links = this.contactLinks;
    if (!links) return;
    void links.linkForPerson(MembershipService.membershipKey(user), async () =>
      (await this.membership.listActiveMemberships(user)).map((m) => m.workspaceId),
    );
  }

  /** A person's own sign-in: a verified email and no client, delegation or
   *  federation identity. Service callers never trigger the link write. */
  private static isPersonProfile(profile: any): boolean {
    return (
      typeof profile?.email === 'string' &&
      profile.email.trim() !== '' &&
      profile?.email_verified === true &&
      !profile?.act &&
      !profile?.client_id &&
      !profile?.clientId &&
      !profile?.__federationActor
    );
  }

  /** Mint a local HS256 session token for a resolved user (post OIDC callback). */
  async generateTokenForUser(user: User) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: 'MEMBER',
      username: user.username,
      email_verified:
        (user as User & { __verifiedEmail?: string | null }).__verifiedEmail ===
        user.email.trim().toLowerCase(),
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
  async validateJwtPayload(payload: any, forwardedAccessToken?: string): Promise<User> {
    // PO-CONN: the userinfo resolver needs the verified issuer + expiry, which
    // the strategy's profile projection drops. Pass the verified payload in
    // alongside the profile; it reaches only the resolver (validateKeycloakUser
    // ignores it) and never the JIT branches.
    const userinfoToken = {
      iss: payload?.iss,
      exp: typeof payload?.exp === 'number' ? payload.exp : undefined,
    };
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
        email_verified: payload.email_verified === true,
        client_id: payload.client_id,
        clientId: payload.clientId,
        act: payload.act,
        __federationActor: isBrigadeFederationToken,
      };
      // A no-email human realm bearer is a HUMAN-session token too (PO-CONN):
      // it carries no email claim, so `isHumanRealmToken` (which requires one)
      // would skip it and the service would 401 with invalid_token — the
      // sign-in loop a web connector falls into. Accept both shapes here; the
      // no-email one is only ever enriched via the realm userinfo endpoint
      // (step 3.5), never admitted without a resolved email.
      const humanRealmToken =
        isKeycloakRealmToken &&
        !isBrigadeFederationToken &&
        (AuthService.isHumanRealmToken(payload) || AuthService.isNoEmailHumanRealmToken(payload)) &&
        typeof forwardedAccessToken === 'string' &&
        !forwardedAccessToken.startsWith('co_pat_');
      return humanRealmToken
        ? this.validateKeycloakUser(
            payload.sub,
            profile,
            forwardedAccessToken,
            { cacheEntitlement: true, tokenExp: payload.exp },
            userinfoToken,
          )
        : this.validateKeycloakUser(payload.sub, profile);
    }

    // Locally-signed session token.
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User not found or inactive');
    }
    // AUD-CR-1: the browser runs on this minted session token, so a tenant that
    // appears after first sign-in is linked here (per-person back-off applies).
    // Only a person's session: verified email, no client/delegation identity.
    if (
      AuthService.isPersonProfile(payload) &&
      !(typeof forwardedAccessToken === 'string' && forwardedAccessToken.startsWith('co_pat_'))
    ) {
      this.linkContactOps(user);
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

  /**
   * The realm issuers that already verified a forwarded token's signature:
   * the configured Keycloak realm issuer (exact value) and the configured
   * federation issuer set. Only an `iss` in this set may be userinfo-fetched
   * (guard (a) — the issuer must be one that verified the signature).
   */
  private static trustedRealmIssuers(): Set<string> {
    const set = new Set<string>(AuthService.brigadeTrustedIssuers());
    const primary = AuthService.primaryRealmIssuer();
    if (primary) set.add(primary);
    return set;
  }

  /** The configured Keycloak realm issuer (exact value), or null when unset. */
  private static primaryRealmIssuer(): string | null {
    const base = (process.env.KEYCLOAK_PUBLIC_URL || process.env.KEYCLOAK_URL || '').replace(
      /\/$/,
      '',
    );
    const realm = process.env.KEYCLOAK_REALM;
    if (!base || !realm) return null;
    return `${base}/realms/${encodeURIComponent(realm)}`;
  }

  /** Realm users have a verified email; service/machine tokens do not. */
  private static isHumanRealmToken(payload: any): boolean {
    return (
      typeof payload?.email === 'string' &&
      payload.email.trim() !== '' &&
      payload?.email_verified === true &&
      !payload?.act &&
      !payload?.client_id &&
      !payload?.clientId
    );
  }

  /**
   * PO-CONN: a HUMAN realm session whose claims carry no email — exactly the
   * token a web connector forwards that today resolves to "no email" and 401s
   * (the sign-in loop). Same shape as `isHumanRealmToken` minus the email
   * claims; these are the only bearers the service may enrich via the realm
   * userinfo endpoint. Mirrors JwtStrategy.isNoEmailHumanRealmPayload.
   */
  private static isNoEmailHumanRealmToken(payload: any): boolean {
    return (
      !(typeof payload?.email === 'string' && payload.email.trim() !== '') &&
      !payload?.act &&
      !payload?.client_id &&
      !payload?.clientId
    );
  }
}
