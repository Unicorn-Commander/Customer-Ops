import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { EntitlementsService } from './entitlements.service';
import {
  WithWorkspaceClaim,
  defaultWorkspaceId,
  resolveWorkspaceId,
} from '../common/workspace/workspace.util';

/**
 * Sources the acting user's entitlement SKUs from the Ops-Center entitlements
 * endpoint and stamps them onto `req.user.__entitlements`, AFTER JwtAuthGuard has
 * resolved the user (guards always run before interceptors). Every existing gate
 * — the dual-SKU federation gates (`entitlementsOf` -> `checkEntitlement`) and the
 * `UC_ENTITLEMENT_MODE` machinery — then reads the endpoint-sourced list with no
 * downstream change.
 *
 * DORMANT unless `ENTITLEMENTS_ENDPOINT_URL` is set (EntitlementsService.isConfigured
 * is false -> this no-ops and the token claim stays the source). When the endpoint
 * cannot answer (an HS256 session token, an auth/membership rejection, or a cold
 * outage) `resolve()` returns null and we leave the claim-sourced value untouched.
 *
 * Launch gate (`ENTITLEMENTS_LAUNCH_GATE=enforce`, default off): on a DEFINITIVE
 * answer (a 200) lacking the launch feature_key (`customer_ops_access`), deny with
 * 403. An indeterminate answer (null) never hard-denies here — that path falls
 * back to the claim, so the primary HS256-session login is never locked out by a
 * launch-gate flag flip.
 */
@Injectable()
export class EntitlementsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(EntitlementsInterceptor.name);
  private readonly enforce: boolean;
  private readonly launchKey: string;
  private readonly workspaceIsOrg: boolean;

  constructor(
    private readonly entitlements: EntitlementsService,
    config: ConfigService,
  ) {
    this.enforce =
      (config.get<string>('ENTITLEMENTS_LAUNCH_GATE') || 'off').trim().toLowerCase() ===
      'enforce';
    this.launchKey = (
      config.get<string>('ENTITLEMENTS_LAUNCH_FEATURE_KEY') || 'customer_ops_access'
    ).trim();
    this.workspaceIsOrg =
      (config.get<string>('ENTITLEMENTS_WORKSPACE_IS_ORG') || '').trim().toLowerCase() ===
      'true';
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    if (!this.entitlements.isConfigured() || context.getType() !== 'http') {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest();
    const user = req?.user as WithWorkspaceClaim | undefined;
    if (!user) return next.handle(); // unauthenticated route — nothing to source

    const rawToken = this.bearer(req);
    const orgId = this.workspaceIsOrg ? resolveWorkspaceId(user, defaultWorkspaceId()) : undefined;

    const result = await this.entitlements.resolve(rawToken, orgId);
    if (result) {
      // Endpoint is authoritative: replace the claim-sourced list (the existing
      // federation gates + UC_ENTITLEMENT_MODE consume this unchanged).
      user.__entitlements = this.entitlements.toSkuList(result.featureKeys);
      if (this.enforce && !result.featureKeys.includes(this.launchKey)) {
        this.logger.warn(
          `launch gate DENY: org=${result.orgId ?? '?'} lacks ${this.launchKey} ` +
            `(has: ${result.featureKeys.join(',') || 'none'})`,
        );
        throw new ForbiddenException(
          `This workspace is not entitled to Customer-Ops (${this.launchKey}).`,
        );
      }
    }
    // result === null -> leave req.user.__entitlements (the claim value) as-is.
    return next.handle();
  }

  private bearer(req: any): string | null {
    const h = req?.headers?.authorization;
    if (typeof h !== 'string') return null;
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1].trim() : null;
  }
}
