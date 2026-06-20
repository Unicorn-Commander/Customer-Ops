import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ModuleRef, Reflector } from '@nestjs/core';
import { Request } from 'express';
import { isPatToken } from '../pat/pat.util';
import { PatService } from '../pat/pat.service';
import { JWT_ONLY_KEY } from '../decorators/jwt-only.decorator';
import { REQUIRE_SCOPES_KEY } from '../decorators/require-scopes.decorator';
import { expandScopes, PatScope } from '../pat/pat.constants';
import { explicitRequestedWorkspaceId } from '../../common/workspace/workspace.util';

/**
 * Auth chokepoint for protected routes.
 *
 *   1. `@Public()` routes skip auth.
 *   2. If the bearer starts with `co_pat_` we resolve it via PatService —
 *      bcrypt-compare against active token hashes, bump lastUsedAt, attach the
 *      User AND the matched PAT to the request, and return true. A PAT-shaped
 *      value that doesn't resolve is a hard 401 (a PAT can never be a valid JWT,
 *      so we never fall through to JWT parsing).
 *
 *      WORKSPACE SCOPING (SUITE-IDENTITY §D4): a PAT is bound to one workspace.
 *      An explicit path-param `workspaceId`/`workspace_id` or `X-Workspace-Id`
 *      header MUST equal the PAT's bound workspace (else 403 — a `co_pat_` for
 *      W1 cannot act on W2). On success the PAT's workspace becomes the request's
 *      `__workspaceClaim` + `req.workspaceId`, so the GUC chokepoint
 *      (WorkspaceContextService.runForUser) scopes every query to it. (The MCP
 *      JSON-RPC `workspace_id` arg is invisible here — McpService re-fences it.)
 *
 *      SCOPE ENFORCEMENT (deny-by-default): a PAT may only reach a route that
 *      declares its required scope via `@RequireScopes(...)`, and only if the
 *      token holds it (write ⊇ read). An un-annotated route is PAT-inaccessible.
 *      A JWT session ignores scopes entirely (full RBAC).
 *   3. Otherwise delegate to Passport's JWT strategy (local HS256 session,
 *      Keycloak realm RS256, Brigade federation RS256 — see jwt.strategy.ts).
 *
 * The guard is applied per-route via `@UseGuards(JwtAuthGuard)`; the
 * `if (request.user) return true` short-circuit keeps it idempotent (and
 * future-proofs against a route that also registers it globally). PatService is
 * resolved lazily via ModuleRef so the guard adds no constructor coupling.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private patService?: PatService;

  constructor(
    private reflector: Reflector,
    private moduleRef: ModuleRef,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Skip non-HTTP execution contexts cleanly (no request to read).
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();

    // Idempotency: if a prior guard pass already resolved the principal, accept
    // (don't re-bcrypt a PAT).
    if ((request as any).user) return true;

    const token = extractBearerToken(request);

    if (token && isPatToken(token)) {
      // Session-only routes (e.g. the PAT management endpoints) reject a PAT
      // bearer — a leaked PAT must not be able to mint/revoke PATs.
      const jwtOnly = this.reflector.getAllAndOverride<boolean>(JWT_ONLY_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (jwtOnly) {
        throw new ForbiddenException(
          'Personal access tokens cannot be used on this route; sign in with your session.',
        );
      }

      const pats = await this.resolvePatService();
      const resolved = await pats.findByPlaintext(token);
      if (!resolved) throw new UnauthorizedException('Invalid token');

      const patWorkspaceId = resolved.workspaceId;
      if (patWorkspaceId) {
        const requested = explicitRequestedWorkspaceId(request);
        if (requested && requested !== patWorkspaceId) {
          this.logger.warn(
            `403 PAT workspace scope: token bound to ${patWorkspaceId} but request addressed ${requested} (user=${resolved.user.email})`,
          );
          throw new ForbiddenException('This token is not scoped to the requested workspace.');
        }
        // A PAT carries no JWT claim of its own — make its bound workspace the
        // request's effective claim so the GUC chokepoint + membership guard
        // resolve to it.
        (resolved.user as any).__workspaceClaim = patWorkspaceId;
        (request as any).workspaceId = patWorkspaceId;
      }

      (resolved.user as any).__ucUid = resolved.user.keycloakId ?? resolved.user.id;
      (request as any).user = resolved.user;
      (request as any).pat = resolved.token;

      // Deny-by-default scope check: a PAT may only reach a route that declares
      // its scope, and only if the token holds it. (JWT sessions never get here.)
      this.enforcePatScopes(context, resolved.token.scopes);
      return true;
    }

    const result = await super.canActivate(context);
    return result instanceof Promise ? await result : (result as boolean);
  }

  /**
   * Enforce `@RequireScopes(...)` for a PAT-authenticated request. Deny-by-
   * default: an un-annotated route (no metadata) is unreachable with a PAT; an
   * `@RequireScopes()` with no scopes admits any PAT (identity/whoami routes);
   * otherwise the token must hold every required scope after write⊇read
   * expansion. Throws ForbiddenException on a miss; returns on success.
   */
  private enforcePatScopes(context: ExecutionContext, grantedScopes: string[]): void {
    const required = this.reflector.getAllAndOverride<PatScope[]>(REQUIRE_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined) {
      throw new ForbiddenException('This route is not accessible with a personal access token.');
    }
    if (required.length === 0) return; // any authenticated PAT (no resource scope)

    const granted = expandScopes(grantedScopes);
    const missing = required.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `This personal access token is missing the required scope(s): ${missing.join(', ')}.`,
      );
    }
  }

  private async resolvePatService(): Promise<PatService> {
    if (!this.patService) {
      // strict:false so ModuleRef finds PatService from the auth module context.
      this.patService = this.moduleRef.get(PatService, { strict: false });
    }
    return this.patService;
  }
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers?.authorization ?? (request.headers as any)?.Authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(/\s+/, 2);
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}
