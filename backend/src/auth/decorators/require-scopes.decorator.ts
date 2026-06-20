import { SetMetadata } from '@nestjs/common';
import { PatScope } from '../pat/pat.constants';

export const REQUIRE_SCOPES_KEY = 'requiredPatScopes';

/**
 * Declare which Personal Access Token scope(s) a route requires. This is the
 * REST half of PAT scope enforcement (the MCP half is MCP_TOOL_SCOPE_MAP); the
 * JwtAuthGuard reads this metadata after it resolves a `co_pat_` bearer.
 *
 * Semantics (a PAT only — a normal JWT session ignores all of this and runs
 * under the user's full workspace RBAC):
 *
 *   @RequireScopes('write:customers')  the token must hold write:customers
 *                                      (write ⊇ read, so it also covers any
 *                                      read:customers route — see expandScopes).
 *   @RequireScopes()                   any authenticated PAT, no resource scope
 *                                      — for identity/whoami reads only.
 *   (no decorator)                     DENY-BY-DEFAULT: a PAT cannot reach this
 *                                      route at all (it 403s). New routes are
 *                                      PAT-inaccessible until explicitly opened.
 *
 * Apply at the class level when every route shares one scope (e.g. agents →
 * run:agents), or per-route when a controller mixes read/write surfaces. A
 * handler-level decorator overrides a class-level one.
 */
export const RequireScopes = (...scopes: PatScope[]) => SetMetadata(REQUIRE_SCOPES_KEY, scopes);
